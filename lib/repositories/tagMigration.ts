import type { LegacyCategory, LegacyPasswordEntry } from '@/lib/types';
import { getStorage } from '@/lib/storage';

/**
 * 分类 → 标签 的一次性迁移。
 *
 * 背景：早期版本同时存在「分类」（每条密码只能属于一个）与「标签」（可多选、带颜色），
 * 两套体系在仓储、API 与界面上几乎完全重复。现已统一为标签：
 * 分类名会变成同名标签，并合并进条目的 tags。
 *
 * 设计要点：
 * - 幂等：写完标记键不再执行，重复调用零成本；
 * - 保守：找不到对应分类的 categoryId 直接丢弃，不留悬空引用；
 * - 先改条目再删分类键，中途失败可重跑（此时分类键仍在，不会丢数据）。
 */

const MIGRATION_FLAG = (ownerId: string) => `pm:${ownerId}:__meta__:categories_migrated`;
const CATEGORY_INDEX = (ownerId: string) => `pm:${ownerId}:categories:__index__`;
const CATEGORY_KEY = (ownerId: string, id: string) => `pm:${ownerId}:categories:${id}`;
const PASSWORD_KEY = (ownerId: string, id: string) => `pm:${ownerId}:passwords:${id}`;
const PASSWORDS_INDEX = (ownerId: string) => `pm:${ownerId}:passwords:__index__`;

export interface MigrationResult {
  /** 已迁移过，或本次无需处理 */
  skipped: boolean;
  /** 由分类转换而来的新标签数 */
  tagsCreated: number;
  /** 被补上分类对应标签的密码条目数 */
  entriesUpdated: number;
  /** 清理掉的分类数 */
  categoriesRemoved: number;
}

/**
 * 执行迁移。调用点位于密码仓储的读路径上，
 * 因此这里直接操作存储，绝不回调 getAllPasswordEntries（会再次触发迁移）。
 */
export async function migrateCategoriesToTags(ownerId: string): Promise<MigrationResult> {
  const storage = getStorage();
  const skipped: MigrationResult = {
    skipped: true,
    tagsCreated: 0,
    entriesUpdated: 0,
    categoriesRemoved: 0,
  };

  if (await storage.get<boolean>(MIGRATION_FLAG(ownerId))) return skipped;

  const categoryIds = (await storage.get<string[]>(CATEGORY_INDEX(ownerId))) ?? [];
  const passwordIds = (await storage.get<string[]>(PASSWORDS_INDEX(ownerId))) ?? [];

  // 全新保险库：直接打标记，省掉每次读都空跑一遍
  if (categoryIds.length === 0 && passwordIds.length === 0) {
    await storage.put(MIGRATION_FLAG(ownerId), true);
    return skipped;
  }

  const { findTagByName, findOrCreateTag } = await import('./tagRepository');

  // 1) 分类名 -> 标签，记录旧 id 到新 id 的映射
  const categoryIdToTagId = new Map<string, string>();
  let tagsCreated = 0;
  for (const catId of categoryIds) {
    const category = await storage.get<LegacyCategory>(CATEGORY_KEY(ownerId, catId));
    if (!category || !category.name?.trim()) continue;

    const name = category.name.trim();
    const existed = await findTagByName(ownerId, name);
    const tag = existed ?? (await findOrCreateTag(ownerId, name));
    if (!existed) tagsCreated++;
    categoryIdToTagId.set(catId, tag.id);
  }

  // 2) 条目补上标签并去掉 categoryId
  let entriesUpdated = 0;
  for (const id of passwordIds) {
    const entry = await storage.get<LegacyPasswordEntry>(PASSWORD_KEY(ownerId, id));
    if (!entry || !entry.categoryId) continue;

    const tagId = categoryIdToTagId.get(entry.categoryId);
    const currentTags = entry.tags ?? [];
    const tags = tagId && !currentTags.includes(tagId) ? [...currentTags, tagId] : currentTags;

    const migrated = { ...entry, tags };
    delete migrated.categoryId;
    await storage.put(PASSWORD_KEY(ownerId, id), migrated);
    entriesUpdated++;
  }

  // 3) 清理分类键并打标记
  for (const catId of categoryIds) {
    await storage.delete(CATEGORY_KEY(ownerId, catId));
  }
  await storage.delete(CATEGORY_INDEX(ownerId));
  await storage.put(MIGRATION_FLAG(ownerId), true);

  return {
    skipped: false,
    tagsCreated,
    entriesUpdated,
    categoriesRemoved: categoryIds.length,
  };
}

/** 只读地查看迁移是否已完成（供设置页展示，不触发迁移） */
export async function isCategoryMigrationDone(ownerId: string): Promise<boolean> {
  return Boolean(await getStorage().get<boolean>(MIGRATION_FLAG(ownerId)));
}