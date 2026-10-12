'use server';

import { nanoid } from 'nanoid';
import { redirect } from 'next/navigation';
import { getSessionAuthContext } from '@/lib/auth/context';
import { AuthenticationError, AppError, ValidationError } from '@/lib/errors';
import {
  createBackup,
  restoreBackup,
  deleteBackup,
  loadBackupSecret,
  wrapPassphrase,
  maybeRunScheduledBackup,
  getBackupRecords,
  getBackupSettings,
  saveBackupSettings,
  saveBackupRecord,
  publicSettings,
} from '@/lib/backup';
import { getCapabilities, testTarget } from '@/lib/backup/targets';
import { assertBackupPassphrase, assertAdminPassword, openBackupFile, openInnerLayer, readContainerHeader } from '@/lib/backup/crypto';
import { BACKUP_FILE_EXTENSION } from '@/lib/backup/fileFormat';
import { encryptAESGCM, decryptAESGCM, deriveMasterKey } from '@/lib/crypto';
import { getConfig } from '@/lib/repositories/configRepository';
import type { BackupRecord, BackupSettings, BackupTarget } from '@/lib/backup/types';

/**
 * 校验用户输入的管理员密码是否真的是当前保险库的主密码。
 *
 * 内层密钥由「管理员密码 + 账号名」派生，如果这里放过一个拼错的密码，
 * 产出的备份将永远无法打开 —— 必须在落盘前拦住。
 * 做法：用会话主密钥加密一段探针，再用输入密码派生的密钥尝试解密。
 */
async function assertAdminPasswordMatches(
  password: string,
  masterKey: CryptoKey
): Promise<void> {
  assertAdminPassword(password);
  const config = await getConfig();
  if (!config) throw new AuthenticationError('保险库尚未初始化');

  const probe = await encryptAESGCM(masterKey, 'freebuff-admin-probe');
  const candidate = await deriveMasterKey(
    password,
    config.masterSalt,
    config.pbkdf2Iterations
  );
  try {
    const text = await decryptAESGCM(candidate, probe.iv, probe.ciphertext, probe.tag);
    if (text !== 'freebuff-admin-probe') throw new Error('mismatch');
  } catch {
    throw new AuthenticationError('管理员密码不正确，无法生成可恢复的备份');
  }
}

async function requireContext() {
  const ctx = await getSessionAuthContext();
  if (!ctx) redirect('/login');
  return ctx;
}

export interface BackupOverview {
  records: Awaited<ReturnType<typeof getBackupRecords>>;
  settings: BackupSettings;
  capabilities: ReturnType<typeof getCapabilities>;
}

/** 备份管理页所需的全部数据 */
export async function getBackupOverviewAction(): Promise<BackupOverview> {
  await requireContext();
  const [records, settings, capabilities] = await Promise.all([
    getBackupRecords(),
    getBackupSettings(),
    Promise.resolve(getCapabilities()),
  ]);
  // 不把包装后的备份密码密文传给客户端
  return { records, settings: publicSettings(settings), capabilities };
}

export interface CreateBackupInput {
  passphrase?: string;
  /** 内层认证用：管理员密码 */
  adminPassword: string;
  /** 是否记住该备份密码（用主密钥加密后保存，供自动备份使用） */
  rememberPassphrase?: boolean;
  targets: BackupTarget[];
  includeSecrets: boolean;
}

export async function createBackupAction(input: CreateBackupInput) {
  const ctx = await requireContext();
  const settings = await getBackupSettings();

  const passphrase = input.passphrase?.trim() || (await unwrapOrThrow(settings, ctx.masterKey));
  assertBackupPassphrase(passphrase);

  // 客户端可能因为缓存了旧版本页面而完全不发这个字段，
  // 此时必须给出「缺少字段」而不是「长度不够」的错误，否则会误导用户。
  if (!input.adminPassword?.trim()) {
    throw new ValidationError(
      '缺少管理员密码：备份已升级为两层认证，请在「第 2 层 · 管理员密码」中填写保险库主密码。若页面上看不到该输入框，请刷新页面（必要时重启开发服务器）以加载最新版本。',
      { field: 'adminPassword' }
    );
  }
  // 内层密钥由管理员密码派生，输入错误会导致备份永远打不开
  await assertAdminPasswordMatches(input.adminPassword, ctx.masterKey);

  const result = await createBackup({
    ownerId: ctx.ownerId,
    passphrase,
    adminPassword: input.adminPassword,
    targets: input.targets,
    reason: 'manual',
    includeSecrets: input.includeSecrets,
  });

  if (input.rememberPassphrase && input.passphrase?.trim()) {
    await saveBackupSettings({
      ...settings,
      wrappedPassphrase: await wrapPassphrase(input.passphrase.trim(), ctx.masterKey),
    });
  }

  return {
    ok: true as const,
    record: result.record,
    partial: result.partial,
  };
}

export async function deleteBackupAction(id: string) {
  await requireContext();
  await deleteBackup(id);
  return { ok: true as const };
}

/** 导出备份文件内容（供浏览器下载） */
export async function getBackupFileAction(
  id: string,
  passphrase: string,
  adminPassword?: string
) {
  await requireContext();
  const records = await getBackupRecords();
  const record = records.find((r) => r.id === id);
  if (!record) throw new AppError('BACKUP_NOT_FOUND', '备份不存在', 404);

  const { getAdapter } = await import('@/lib/backup/targets');
  const delivery = record.deliveries.find((d) => d.ok);
  if (!delivery) throw new AppError('BACKUP_NO_DELIVERY', '该备份已无可用副本', 404);

  const text = await getAdapter(delivery.target).get(delivery.location);
  if (passphrase && adminPassword) {
    // 两层都校验一遍，确保下载的是用户真正能打开的备份
    const { envelope } = await openBackupFile(text, passphrase);
    await openInnerLayer(envelope, adminPassword, envelope.adminUsername);
  }
  return {
    filename: `freebuff-backup-${record.createdAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}${BACKUP_FILE_EXTENSION}`,
    content: text,
  };
}

/**
 * 恢复出厂设置前自动留底。
 * 注意：库内快照会被重置本身清除，因此只用能存活到重置之后的目标
 * （本地文件 / git 仓库）；无可用外部目标时返回 skipped，不阻断重置。
 */
export async function createPreResetBackupAction() {
  const ctx = await requireContext();
  const settings = await getBackupSettings();
  const configured = (settings.targets.length ? settings.targets : ['database']) as BackupTarget[];
  const durable = configured.filter((t) => t !== 'database');

  if (durable.length === 0) {
    return {
      ok: false as const,
      skipped: true as const,
      reason: '当前只配置了数据库快照，而它会被重置一并清除；请先配置本地文件或 git 仓库目标',
    };
  }

  let passphrase = process.env.BACKUP_PASSPHRASE;
  if (!passphrase) {
    try {
      const { unwrapPassphrase } = await import('@/lib/backup');
      passphrase = await unwrapPassphrase(settings.wrappedPassphrase, ctx.masterKey);
    } catch {
      return { ok: false as const, skipped: true as const, reason: '没有可用的备份密码，已跳过' };
    }
  }

  // 内层认证需要管理员密码；重置后主密码会变，因此只能用环境变量里的那份
  const adminPassword = process.env.BACKUP_ADMIN_PASSWORD;
  if (!adminPassword) {
    return {
      ok: false as const,
      skipped: true as const,
      reason: '未配置 BACKUP_ADMIN_PASSWORD，无法生成带内层认证的备份，已跳过',
    };
  }

  try {
    const result = await createBackup({
      ownerId: ctx.ownerId,
      passphrase,
      adminPassword,
      targets: durable,
      reason: 'pre-reset',
      includeSecrets: true,
    });
    return { ok: true as const, skipped: false as const, record: result.record, partial: result.partial };
  } catch (err) {
    return {
      ok: false as const,
      skipped: false as const,
      reason: err instanceof Error ? err.message : '重置前备份失败',
    };
  }
}

/**
 * 导入本地备份文件（.fbk），存入库内快照并登记元数据。
 * 恢复出厂设置后索引会被清除，可用它把外部备份重新纳管。
 */
export async function importBackupFileAction(input: {
  filename: string;
  content: string;
  passphrase?: string;
  adminPassword?: string;
}) {
  await requireContext();
  const { sha256Hex } = await import('@/lib/backup/crypto');
  const { putDatabase } = await import('@/lib/backup/targets/database');
  const { getAdapter } = await import('@/lib/backup/targets');

  // 解析头部（不触发任何 KDF），顺便校验文件确实是我们自己的格式
  let header;
  try {
    header = readContainerHeader(input.content);
  } catch (err) {
    throw new AppError(
      'BACKUP_FILE_INVALID',
      err instanceof Error ? err.message : '不是有效的 Freebuff 备份文件',
      400
    );
  }

  const id = nanoid();
  const stored = await putDatabase(id, input.content);
  const checksum = await sha256Hex(input.content);

  let summary: BackupRecord['summary'] = {
    passwords: 0,
    tags: 0,
    includesSecrets: false,
    adminUsername: header.adminUsername || undefined,
  };

  if (input.passphrase && input.adminPassword) {
    try {
      const { envelope } = await openBackupFile(input.content, input.passphrase);
      const secret = await openInnerLayer(envelope, input.adminPassword, envelope.adminUsername);
      summary = {
        passwords: secret.vault.passwords.length,
        tags: secret.vault.tags.length,
        includesSecrets: secret.includesSecrets,
        adminUsername: secret.adminUsername || undefined,
      };
    } catch (err) {
      await getAdapter('database').remove(stored.location);
      throw new AppError(
        'BACKUP_CREDENTIALS_INVALID',
        `备份密码或管理员密码错误，或文件已损坏：${err instanceof Error ? err.message : String(err)}`,
        400
      );
    }
  }

  const record: BackupRecord = {
    id,
    version: header.version,
    createdAt: header.createdAt,
    reason: 'manual',
    summary,
    size: stored.size,
    checksum,
    deliveries: [
      {
        target: 'database',
        ok: true,
        location: stored.location,
        size: stored.size,
        at: new Date().toISOString(),
      },
    ],
  };

  await saveBackupRecord(record);
  return { ok: true as const, record };
}

export interface RestoreInput {
  id: string;
  passphrase: string;
  adminPassword: string;
  strategy: 'skip' | 'overwrite' | 'duplicate';
  restoreConfig?: boolean;
}

export async function restoreBackupAction(input: RestoreInput) {
  const ctx = await requireContext();
  const result = await restoreBackup({
    recordId: input.id,
    ownerId: ctx.ownerId,
    passphrase: input.passphrase,
    adminPassword: input.adminPassword,
    strategy: input.strategy,
    masterKey: ctx.masterKey,
    restoreConfig: input.restoreConfig,
  });
  return { ok: true as const, result };
}

/** 同时校验两层认证（备份密码 + 管理员密码），不导入任何数据 */
export async function verifyBackupCredentialsAction(
  id: string,
  passphrase: string,
  adminPassword: string
) {
  await requireContext();
  const records = await getBackupRecords();
  const record = records.find((r) => r.id === id);
  if (!record) throw new AppError('BACKUP_NOT_FOUND', '备份不存在', 404);
  try {
    const secret = await loadBackupSecret(record, { passphrase, adminPassword });
    return {
      ok: true as const,
      owner: secret.adminUsername,
      passwords: secret.vault.passwords.length,
    };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : '备份密码或管理员密码错误',
    };
  }
}

export async function testBackupTargetAction(target: BackupTarget) {
  await requireContext();
  return testTarget(target);
}

export interface SaveSettingsInput {
  enabled: boolean;
  intervalHours: number;
  targets: BackupTarget[];
  retention: number;
  includeSecrets: boolean;
  /** 新设置的备份密码；留空表示不修改已保存的 */
  passphrase?: string;
  forgetPassphrase?: boolean;
}

export async function saveBackupSettingsAction(input: SaveSettingsInput) {
  const ctx = await requireContext();
  const current = await getBackupSettings();

  let wrappedPassphrase = current.wrappedPassphrase;
  if (input.forgetPassphrase) {
    wrappedPassphrase = undefined;
  } else if (input.passphrase?.trim()) {
    assertBackupPassphrase(input.passphrase.trim());
    wrappedPassphrase = await wrapPassphrase(input.passphrase.trim(), ctx.masterKey);
  }

  if (input.enabled && !wrappedPassphrase && !process.env.BACKUP_PASSPHRASE) {
    throw new AppError(
      'BACKUP_PASSPHRASE_REQUIRED',
      '启用自动备份前请先设置备份密码，否则无人值守时无法加密备份',
      400
    );
  }

  // 自动备份没有会话，拿不到管理员密码，只能依赖环境变量
  if (input.enabled && !process.env.BACKUP_ADMIN_PASSWORD) {
    throw new AppError(
      'BACKUP_ADMIN_PASSWORD_REQUIRED',
      '启用自动备份前请配置环境变量 BACKUP_ADMIN_PASSWORD，否则无人值守时无法完成内层认证',
      400
    );
  }

  const saved = await saveBackupSettings({
    enabled: input.enabled,
    intervalHours: Math.min(Math.max(input.intervalHours, 1), 720),
    targets: input.targets,
    retention: Math.min(Math.max(input.retention, 1), 100),
    includeSecrets: input.includeSecrets,
    wrappedPassphrase,
  });

  return { ok: true as const, settings: publicSettings(saved) };
}

/** 定时检查：尊重间隔，到期才真正备份（供页面定时器调用） */
export async function checkAutoBackupAction() {
  const ctx = await requireContext();
  const outcome = await maybeRunScheduledBackup({
    ownerId: ctx.ownerId,
    masterKey: ctx.masterKey,
  });
  return { ran: outcome.ran, reason: outcome.reason, error: outcome.error };
}

/** 忽略间隔立即执行一次自动备份（设置页的「立即执行」） */
export async function forceAutoBackupAction() {
  const ctx = await requireContext();
  const outcome = await maybeRunScheduledBackup(
    { ownerId: ctx.ownerId, masterKey: ctx.masterKey },
    { force: true }
  );
  return { ran: outcome.ran, reason: outcome.reason, error: outcome.error };
}

async function unwrapOrThrow(settings: BackupSettings, masterKey: CryptoKey): Promise<string> {
  if (process.env.BACKUP_PASSPHRASE) return process.env.BACKUP_PASSPHRASE;
  if (!settings.wrappedPassphrase) {
    throw new AuthenticationError('请输入备份密码，或先在设置中保存一个备份密码');
  }
  const { unwrapPassphrase } = await import('@/lib/backup');
  return unwrapPassphrase(settings.wrappedPassphrase, masterKey);
}
