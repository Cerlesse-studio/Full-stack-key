import { nanoid } from 'nanoid';
import { AppError, ValidationError, NotFoundError } from '@/lib/errors';
import { encryptAESGCM, decryptAESGCM, deriveMasterKey } from '@/lib/crypto';
import { decryptEntry } from '@/lib/repositories/passwordRepository';
import { exportAllData, importPasswords } from '@/lib/repositories/passwordRepository';
import { importTags } from '@/lib/repositories/tagRepository';
import { getConfig, saveConfig } from '@/lib/repositories/configRepository';
import {
  getBackupRecords,
  findBackupRecord,
  saveBackupRecord,
  removeBackupRecord,
  getBackupSettings,
  saveBackupSettings,
} from '@/lib/repositories/backupRepository';

export { publicSettings } from '@/lib/repositories/backupRepository';
import { getAdapter, targetAvailable } from './targets';
import { sealBackupFile, openBackupFile, openInnerLayer, sha256Hex } from './crypto';
import { readContainerHeader } from './crypto';
import type {
  BackupCredentials,
  BackupSecret,
  BackupReason,
  BackupRecord,
  BackupSettings,
  BackupTarget,
  CreateBackupResult,
  RestoreResult,
  WrappedPassphrase,
} from './types';
import { BACKUP_TARGETS } from './types';
import { BACKUP_CONTAINER_VERSION } from './fileFormat';

export const BACKUP_FORMAT_VERSION = 2;

export interface CreateBackupOptions extends BackupCredentials {
  ownerId: string;
  targets: BackupTarget[];
  reason: BackupReason;
  includeSecrets: boolean;
}

export type { WrappedPassphrase };

/**
 * 组装内层明文（只有管理员密码 + 账号名能解开）。
 *
 * 刻意不带 masterPasswordHash：恢复时必须先证明知道管理员密码，
 * 条目会用当前保险库密钥重新加密，因此无需也不能覆盖主密码。
 */
export async function buildSecret(
  ownerId: string,
  includeSecrets: boolean
): Promise<BackupSecret> {
  const [data, config] = await Promise.all([exportAllData(ownerId), getConfig()]);
  if (!config) {
    throw new ValidationError('保险库尚未初始化，无法创建备份');
  }

  return {
    format: 'freebuff-backup-secret',
    version: BACKUP_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    adminUsername: config.adminUsername || '',
    vault: {
      passwords: data.passwords ?? [],
      tags: data.tags ?? [],
    },
    crypto: {
      masterSalt: config.masterSalt,
      pbkdf2Iterations: config.pbkdf2Iterations,
    },
    apiKeys: includeSecrets ? config.apiKeys : undefined,
    includesSecrets: Boolean(includeSecrets),
  };
}

/** 创建备份：加密后分发到各目标，任一目标成功即视为成功 */
export async function createBackup(options: CreateBackupOptions): Promise<CreateBackupResult> {
  const { ownerId, passphrase, adminPassword, targets, reason, includeSecrets } = options;

  if (!targets || targets.length === 0) {
    throw new ValidationError('请至少选择一个备份目标');
  }

  const usable = targets.filter((t) => targetAvailable(t));
  const skipped = targets.filter((t) => !targetAvailable(t));
  if (usable.length === 0) {
    throw new ValidationError(
      `所选目标在当前环境均不可用${skipped.length ? `：${skipped.join('、')}` : ''}`
    );
  }

  const secret = await buildSecret(ownerId, includeSecrets);
  const serialized = await sealBackupFile(secret, { passphrase, adminPassword });
  const checksum = await sha256Hex(serialized);

  const id = nanoid();
  const createdAt = secret.createdAt;
  const deliveries: BackupRecord['deliveries'] = [];

  for (const target of usable) {
    try {
      const result = await getAdapter(target).put(id, createdAt, reason, serialized);
      deliveries.push({
        target,
        ok: true,
        location: result.location,
        size: result.size,
        at: createdAt,
      });
    } catch (err) {
      deliveries.push({
        target,
        ok: false,
        location: '',
        error: err instanceof Error ? err.message : String(err),
        at: createdAt,
      });
    }
  }

  for (const target of skipped) {
    deliveries.push({
      target,
      ok: false,
      location: '',
      error: '当前运行环境不支持或未配置该目标',
      at: createdAt,
    });
  }

  if (deliveries.every((d) => !d.ok)) {
    const reasons = deliveries
      .map((d) => `${d.target}: ${d.error}`)
      .join('；');
    throw new AppError('BACKUP_ALL_TARGETS_FAILED', `备份失败，所有目标都未能写入。${reasons}`, 500);
  }

  const record: BackupRecord = {
    id,
    version: BACKUP_CONTAINER_VERSION,
    createdAt,
    reason,
    summary: {
      passwords: secret.vault.passwords.length,
      tags: secret.vault.tags.length,
      includesSecrets: secret.includesSecrets,
      adminUsername: secret.adminUsername || undefined,
    },
    size: serialized.length,
    checksum,
    deliveries,
  };

  await saveBackupRecord(record);

  if (reason === 'auto') {
    const settings = await getBackupSettings();
    await pruneRetention(settings.retention);
  }

  return { record, partial: deliveries.some((d) => !d.ok) };
}

/**
 * 读取备份文件原文（不做任何解密），用于校验与下载。
 */
export async function loadBackupText(record: BackupRecord): Promise<string> {
  const delivery = record.deliveries.find((d) => d.ok);
  if (!delivery) {
    throw new AppError('BACKUP_NO_DELIVERY', '该备份没有任何可用的存放位置，可能已被清理', 404);
  }

  const text = await getAdapter(delivery.target).get(delivery.location);
  if (record.checksum) {
    const actual = await sha256Hex(text);
    if (actual !== record.checksum) {
      throw new AppError('BACKUP_CHECKSUM_MISMATCH', '备份文件校验失败，文件可能已损坏或被篡改', 400);
    }
  }
  return text;
}

/**
 * 两层解密：先用备份密码拆外层，再用管理员密码 + 账号名拆内层。
 * 缺任意一层都拿不到明文。
 */
export async function loadBackupSecret(
  record: BackupRecord,
  credentials: BackupCredentials
): Promise<BackupSecret> {
  const text = await loadBackupText(record);
  const { envelope } = await openBackupFile(text, credentials.passphrase);
  return openInnerLayer(envelope, credentials.adminPassword, envelope.adminUsername);
}

/** 只读解析备份文件归属（不解密），用于列表展示 */
export function readBackupOwner(text: string): string | undefined {
  try {
    return readContainerHeader(text).adminUsername;
  } catch {
    return undefined;
  }
}

export interface RestoreOptions extends BackupCredentials {
  recordId: string;
  ownerId: string;
  strategy: 'skip' | 'overwrite' | 'duplicate';
  /** 当前保险库的主密钥：条目会用它重新加密，因此主密码不会被覆盖 */
  masterKey: CryptoKey;
  /** 是否同时恢复 API 密钥等配置 */
  restoreConfig?: boolean;
}

/**
 * 用当前保险库的主密钥重新加密条目。
 *
 * 备份里的条目是用「备份来源保险库」的密钥加密的；直接写入会让它们无法解密。
 * 这里先解开再加密，代价是一次性开销，换来的是：
 * 1) 恢复永远不覆盖当前主密码；
 * 2) 备份可以跨保险库恢复（例如换了主密码之后）。
 */
async function reencryptEntries(
  entries: unknown[],
  sourceKey: CryptoKey,
  targetKey: CryptoKey
): Promise<{ ok: unknown[]; failed: number }> {
  const decryptFn = async (ciphertext: string, iv: string, tag: string) =>
    decryptAESGCM(sourceKey, iv, ciphertext, tag);

  const encryptFn = async (plaintext: string) => {
    const enc = await encryptAESGCM(targetKey, plaintext);
    return { encrypted: enc.ciphertext, iv: enc.iv, tag: enc.tag };
  };

  const ok: unknown[] = [];
  let failed = 0;
  for (const raw of entries) {
    try {
      const entry = raw as Parameters<typeof decryptEntry>[0];
      const plain = await decryptEntry(entry, decryptFn);
      const password = await encryptFn(plain.password);
      const notes = plain.notes ? await encryptFn(plain.notes) : undefined;
      ok.push({
        ...entry,
        encryptedPassword: password.encrypted,
        passwordIv: password.iv,
        passwordTag: password.tag,
        encryptedNotes: notes?.encrypted,
        notesIv: notes?.iv,
        notesTag: notes?.tag,
      });
    } catch {
      failed++;
    }
  }
  return { ok, failed };
}

export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  const { recordId, ownerId, passphrase, adminPassword, strategy, masterKey, restoreConfig } =
    options;

  const record = await findBackupRecord(recordId);
  if (!record) throw new NotFoundError(`备份 ${recordId} 不存在`);

  // 第一层：备份密码；第二层：管理员密码 + 账号名
  const secret = await loadBackupSecret(record, { passphrase, adminPassword });
  const warnings: string[] = [];

  if (!secret.includesSecrets && restoreConfig) {
    warnings.push('该备份未包含 API 密钥，配置未被恢复');
  }

  // 来源保险库的主密钥：用管理员密码 + 备份里的盐推导
  const sourceKey = await deriveMasterKey(
    adminPassword,
    secret.crypto.masterSalt,
    secret.crypto.pbkdf2Iterations
  );

  const { ok: entries, failed } = await reencryptEntries(
    secret.vault.passwords as never[],
    sourceKey,
    masterKey
  );
  if (failed > 0) {
    warnings.push(`${failed} 条密码无法解密（可能来自其他保险库），已跳过`);
  }

  // 兼容旧备份：旧格式里的 vault.categories 会在导入时转成同名标签
  const asExport = {
    version: '2.0.0',
    exportedAt: secret.createdAt,
    passwords: entries as never[],
    categories: secret.vault.categories as never[] | undefined,
    tags: secret.vault.tags as never[],
  };

  const passwordResult = await importPasswords(ownerId, asExport, strategy);
  const tagResult = await importTags(ownerId, asExport.tags);

  let configRestored = false;
  if (restoreConfig && secret.includesSecrets && secret.apiKeys?.length) {
    const current = await getConfig();
    if (current) {
      await saveConfig({ ...current, apiKeys: secret.apiKeys as typeof current.apiKeys });
      configRestored = true;
      warnings.push('API 密钥已恢复；主密码保持不变（恢复流程不会覆盖主密码）');
    }
  }

  return {
    passwords: {
      imported: passwordResult.imported,
      skipped: passwordResult.skipped,
      overwritten: passwordResult.overwritten,
      duplicated: passwordResult.duplicated,
    },
    tagsCreated: tagResult.created + passwordResult.tagsFromCategories,
    configRestored,
    warnings,
  };
}

/** 删除备份：尽力清理各目标的副本，并移除元数据 */
export async function deleteBackup(id: string): Promise<BackupRecord> {
  const record = await findBackupRecord(id);
  if (!record) throw new NotFoundError(`备份 ${id} 不存在`);

  for (const delivery of record.deliveries.filter((d) => d.ok)) {
    try {
      await getAdapter(delivery.target).remove(delivery.location);
    } catch {
      // 远端清理失败不阻塞元数据删除
    }
  }
  await removeBackupRecord(id);
  return record;
}

/**
 * 保留策略：每个目标只保留最近 N 份自动备份。
 * 新建的备份已入索引，因此直接按全量排序截断，保留数不会多出一份。
 */
export async function pruneRetention(retention: number): Promise<number> {
  const keep = Math.max(1, retention);
  const records = await getBackupRecords();
  const auto = records.filter((r) => r.reason === 'auto');
  const seen = new Set<string>();
  let removed = 0;

  for (const target of BACKUP_TARGETS) {
    const forTarget = auto
      .filter((r) => r.deliveries.some((d) => d.target === target && d.ok))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    for (const stale of forTarget.slice(keep)) {
      if (seen.has(stale.id)) continue;
      seen.add(stale.id);
      try {
        await deleteBackup(stale.id);
        removed++;
      } catch {
        // 忽略单个失败
      }
    }
  }

  return removed;
}

/** 用主密钥包装备份密码，便于自动备份在无人工输入时解密 */
export async function wrapPassphrase(
  passphrase: string,
  masterKey: CryptoKey
): Promise<WrappedPassphrase> {
  const enc = await encryptAESGCM(masterKey, passphrase);
  return { ciphertext: enc.ciphertext, iv: enc.iv, tag: enc.tag };
}

export async function unwrapPassphrase(
  wrapped: WrappedPassphrase | undefined,
  masterKey: CryptoKey
): Promise<string> {
  if (!wrapped) {
    throw new ValidationError('尚未保存备份密码，无法执行自动备份');
  }
  return decryptAESGCM(masterKey, wrapped.iv, wrapped.ciphertext, wrapped.tag);
}

/* ------------------------------------------------------------------ *
 * 自动备份调度
 * ------------------------------------------------------------------ */

/** 进程内互斥，避免同一实例并发触发 */
let autoBackupInFlight = false;
/** 进程内的最小检查间隔（毫秒），避免每个请求都读一次存储 */
let lastCheckAt = 0;
const MIN_CHECK_INTERVAL_MS = 60_000;

export interface AutoBackupContext {
  ownerId: string;
  /** 会话主密钥，用于解包已保存的备份密码；无会话时（如 Cron）可不传 */
  masterKey?: CryptoKey;
  /** 无人值守场景（如 Cron）可直接提供备份密码 */
  passphrase?: string;
  /** 内层认证所需的管理员密码；缺省时读 BACKUP_ADMIN_PASSWORD */
  adminPassword?: string;
}

export interface AutoBackupOutcome {
  ran: boolean;
  reason: 'disabled' | 'not-due' | 'locked' | 'no-passphrase' | 'no-admin-password' | 'failed' | 'ok';
  record?: BackupRecord;
  error?: string;
}

function intervalMs(settings: BackupSettings): number {
  return Math.max(1, settings.intervalHours) * 60 * 60 * 1000;
}

/**
 * 检查是否到了自动备份时间；到期则执行一次。
 * 供认证请求、页面定时器与 Cron 入口共用。
 * options.force=true 时忽略间隔限制（手动“立即备份”）。
 */
export async function maybeRunScheduledBackup(
  ctx: AutoBackupContext,
  options: { force?: boolean } = {}
): Promise<AutoBackupOutcome> {
  const settings = await getBackupSettings();
  if (!settings.enabled || settings.targets.length === 0) {
    return { ran: false, reason: 'disabled' };
  }

  if (settings.lastRunAt && !options.force) {
    const elapsed = Date.now() - new Date(settings.lastRunAt).getTime();
    if (Number.isFinite(elapsed) && elapsed < intervalMs(settings)) {
      return { ran: false, reason: 'not-due' };
    }
  }

  if (autoBackupInFlight) return { ran: false, reason: 'locked' };
  autoBackupInFlight = true;

  try {
    let passphrase = ctx.passphrase ?? process.env.BACKUP_PASSPHRASE;
    if (!passphrase) {
      if (!ctx.masterKey) throw new ValidationError('无人值守场景缺少备份密码（请配置 BACKUP_PASSPHRASE）');
      passphrase = await unwrapPassphrase(settings.wrappedPassphrase, ctx.masterKey);
    }

    // 内层认证：无人值守时没有会话，只能读环境变量
    const adminPassword = ctx.adminPassword ?? process.env.BACKUP_ADMIN_PASSWORD;
    if (!adminPassword) {
      throw new ValidationError(
        '无人值守备份需要管理员密码作为内层认证（请配置 BACKUP_ADMIN_PASSWORD）'
      );
    }

    const { record, partial } = await createBackup({
      ownerId: ctx.ownerId,
      passphrase,
      adminPassword,
      targets: settings.targets,
      reason: 'auto',
      includeSecrets: settings.includeSecrets,
    });

    await saveBackupSettings({
      ...settings,
      lastRunAt: new Date().toISOString(),
      lastResult: partial ? '部分目标失败' : '成功',
    });
    return { ran: true, reason: 'ok', record };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await saveBackupSettings({ ...settings, lastResult: `失败：${message.slice(0, 120)}` }).catch(
      () => {}
    );
    return { ran: false, reason: 'failed', error: message };
  } finally {
    autoBackupInFlight = false;
  }
}

/**
 * 轻量触发器：带进程内节流，供高频请求路径调用。
 * 未开启或未到期时几乎不产生存储读取。
 */
export async function triggerAutoBackupIfDue(
  ctx: AutoBackupContext
): Promise<AutoBackupOutcome | null> {
  const now = Date.now();
  if (now - lastCheckAt < MIN_CHECK_INTERVAL_MS) return null;
  lastCheckAt = now;
  return maybeRunScheduledBackup(ctx);
}

/** 供测试重置调度器状态 */
export function resetAutoBackupThrottle(): void {
  lastCheckAt = 0;
  autoBackupInFlight = false;
}

export { getBackupSettings, saveBackupSettings, getBackupRecords, saveBackupRecord, findBackupRecord };
