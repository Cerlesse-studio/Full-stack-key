import type { AppConfig } from '@/lib/types';
import { getStorage } from '@/lib/storage';
import type { BackupRecord, BackupSettings } from '@/lib/backup/types';
import { BACKUP_TARGETS } from '@/lib/backup/types';

const BACKUP_INDEX_KEY = 'pm:__backups__';
const BACKUP_SETTINGS_KEY = 'pm:__backup_settings__';

/** 元数据索引最多保留的记录数（超出后删除最旧的自动备份） */
const MAX_INDEX_ENTRIES = 500;

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  enabled: false,
  intervalHours: 24,
  targets: ['database'],
  retention: 7,
  includeSecrets: true,
};

export async function getBackupRecords(): Promise<BackupRecord[]> {
  const storage = getStorage();
  const records = (await storage.get<BackupRecord[]>(BACKUP_INDEX_KEY)) ?? [];
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function findBackupRecord(id: string): Promise<BackupRecord | null> {
  const records = await getBackupRecords();
  return records.find((r) => r.id === id) ?? null;
}

export async function saveBackupRecord(record: BackupRecord): Promise<void> {
  const storage = getStorage();
  const records = await getBackupRecords();
  const next = [record, ...records.filter((r) => r.id !== record.id)];

  // 控制索引体积：超出上限时丢弃最旧的自动备份元数据
  const trimmed = next.slice(0, MAX_INDEX_ENTRIES);
  await storage.put(BACKUP_INDEX_KEY, trimmed);
}

export async function removeBackupRecord(id: string): Promise<BackupRecord | null> {
  const storage = getStorage();
  const records = await getBackupRecords();
  const target = records.find((r) => r.id === id);
  if (!target) return null;
  await storage.put(BACKUP_INDEX_KEY, records.filter((r) => r.id !== id));
  return target;
}

export async function getBackupSettings(): Promise<BackupSettings> {
  const storage = getStorage();
  const settings = await storage.get<BackupSettings>(BACKUP_SETTINGS_KEY);
  if (!settings) return { ...DEFAULT_BACKUP_SETTINGS };
  return {
    ...DEFAULT_BACKUP_SETTINGS,
    ...settings,
    // 旧数据可能包含已失效的目标，这里过滤一次
    targets: (settings.targets ?? DEFAULT_BACKUP_SETTINGS.targets).filter((t) =>
      BACKUP_TARGETS.includes(t)
    ),
  };
}

export async function saveBackupSettings(settings: BackupSettings): Promise<BackupSettings> {
  const storage = getStorage();
  const next: BackupSettings = { ...settings, updatedAt: new Date().toISOString() };
  await storage.put(BACKUP_SETTINGS_KEY, next);
  return next;
}

/** 供客户端读取的设置副本：剔除包装后的备份密码密文 */
export function publicSettings(settings: BackupSettings): BackupSettings {
  const copy = { ...settings };
  delete copy.wrappedPassphrase;
  return copy;
}

/**
 * 恢复出厂设置前调用：把当前配置塞进快照载荷，
 * 由备份服务层负责加密与投递，这里只负责提供安全的配置副本。
 */
export function sanitizeConfigForBackup(
  config: AppConfig,
  includeSecrets: boolean
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    pbkdf2Iterations: config.pbkdf2Iterations,
    createdAt: config.createdAt,
    adminUsername: config.adminUsername,
  };
  if (!includeSecrets) return base;
  // 刻意不含 masterPasswordHash：备份恢复改为两层认证，主密码永不被覆盖
  return {
    ...base,
    masterSalt: config.masterSalt,
    apiKeys: config.apiKeys,
  };
}
