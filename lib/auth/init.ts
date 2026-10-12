import {
  deriveMasterKey,
  deriveMasterKeyBytes,
  hashMasterPassword,
  generateSalt,
  generateSessionToken,
  encryptAESGCM,
  decryptAESGCM,
  importAESKey,
  DEFAULT_ITERATIONS,
} from '@/lib/crypto';
import {
  initializeConfig,
  requireConfig,
  isInitialized,
  updateMasterPassword,
  createSession,
  getSession,
  deleteSession,
  wipeAllVaultData,
  type WipeVaultResult,
} from '@/lib/repositories/configRepository';
import {
  reencryptAllPasswordEntries,
} from '@/lib/repositories/passwordRepository';
import { generateApiKeyRecord } from './apiKey';
import {
  AuthenticationError,
  ConflictError,
  ValidationError,
} from '@/lib/errors';
import type { ApiKey, PasswordEntry } from '@/lib/types';
import type { SessionData } from '@/lib/repositories/configRepository';

export interface InitResult {
  apiKey: string;
  apiKeyRecord: ApiKey;
  adminUsername: string;
  sessionId?: string;
}

export const MIN_ADMIN_USERNAME_LENGTH = 2;
export const MAX_ADMIN_USERNAME_LENGTH = 32;

/** 规范化管理员账号名称：去首尾空白并折叠内部连续空白 */
export function normalizeAdminUsername(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

export async function initializeApp(
  masterPassword: string,
  adminUsername: string
): Promise<InitResult> {
  const already = await isInitialized();
  if (already) {
    throw new ConflictError(
      'Application is already initialized',
      'AUTH_ALREADY_INITIALIZED'
    );
  }

  if (masterPassword.length < 8) {
    throw new AuthenticationError(
      'Master password must be at least 8 characters',
      'AUTH_INVALID_PASSWORD'
    );
  }

  const adminName = normalizeAdminUsername(adminUsername || '');
  if (adminName.length < MIN_ADMIN_USERNAME_LENGTH) {
    throw new ValidationError('管理员账号名称至少 2 个字符', { field: 'adminUsername' });
  }
  if (adminName.length > MAX_ADMIN_USERNAME_LENGTH) {
    throw new ValidationError(`管理员账号名称最多 ${MAX_ADMIN_USERNAME_LENGTH} 个字符`, {
      field: 'adminUsername',
    });
  }

  const masterSalt = generateSalt();
  const kekSalt = generateSalt();
  const iterations = Number(process.env.PBKDF2_ITERATIONS) || DEFAULT_ITERATIONS;

  const masterPasswordHash = await hashMasterPassword(masterPassword, masterSalt, iterations);

  const { apiKey, record: initialApiKey } = await generateApiKeyRecord('Initial API Key');

  await initializeConfig(
    masterPasswordHash,
    masterSalt,
    kekSalt,
    iterations,
    initialApiKey,
    adminName
  );

  return {
    apiKey,
    apiKeyRecord: initialApiKey,
    adminUsername: adminName,
  };
}

export async function verifyMasterPassword(masterPassword: string): Promise<boolean> {
  const config = await requireConfig();
  const expectedHash = await hashMasterPassword(
    masterPassword,
    config.masterSalt,
    config.pbkdf2Iterations
  );

  const a = expectedHash;
  const b = config.masterPasswordHash;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function changeMasterPassword(
  oldPassword: string,
  newPassword: string,
  ownerId: string
): Promise<void> {
  const config = await requireConfig();

  const valid = await verifyMasterPassword(oldPassword);
  if (!valid) {
    throw new AuthenticationError(
      'Current master password is incorrect',
      'AUTH_INVALID_PASSWORD'
    );
  }

  if (newPassword.length < 8) {
    throw new AuthenticationError(
      'New master password must be at least 8 characters',
      'AUTH_INVALID_PASSWORD'
    );
  }

  const oldMasterKey = await deriveMasterKey(
    oldPassword,
    config.masterSalt,
    config.pbkdf2Iterations
  );

  const newMasterSalt = generateSalt();
  const newKekSalt = generateSalt();
  const newIterations = Number(process.env.PBKDF2_ITERATIONS) || DEFAULT_ITERATIONS;
  const newMasterKey = await deriveMasterKey(newPassword, newMasterSalt, newIterations);
  const newMasterPasswordHash = await hashMasterPassword(newPassword, newMasterSalt, newIterations);

  const reencryptEntry = async (entry: PasswordEntry) => {
    let password: string;
    let notes: string | undefined;
    try {
      password = await decryptAESGCM(oldMasterKey, entry.passwordIv, entry.encryptedPassword, entry.passwordTag);
    } catch {
      password = '';
    }
    if (entry.encryptedNotes && entry.notesIv && entry.notesTag) {
      try {
        notes = await decryptAESGCM(oldMasterKey, entry.notesIv, entry.encryptedNotes, entry.notesTag);
      } catch {
        notes = undefined;
      }
    }

    const newPasswordEnc = await encryptAESGCM(newMasterKey, password);
    const result = {
      ...entry,
      encryptedPassword: newPasswordEnc.ciphertext,
      passwordIv: newPasswordEnc.iv,
      passwordTag: newPasswordEnc.tag,
      version: entry.version + 1,
      updatedAt: new Date().toISOString(),
    };

    if (notes && notes.length > 0) {
      const newNotesEnc = await encryptAESGCM(newMasterKey, notes);
      result.encryptedNotes = newNotesEnc.ciphertext;
      result.notesIv = newNotesEnc.iv;
      result.notesTag = newNotesEnc.tag;
    } else {
      result.encryptedNotes = undefined;
      result.notesIv = undefined;
      result.notesTag = undefined;
    }

    return result;
  };

  await reencryptAllPasswordEntries(ownerId, reencryptEntry);
  await updateMasterPassword(newMasterPasswordHash, newMasterSalt, newKekSalt, newIterations);

  // 主密钥已变：用新密钥重新包装已保存的备份密码，否则自动备份将无法解包
  try {
    const { getBackupSettings, saveBackupSettings } = await import(
      '@/lib/repositories/backupRepository'
    );
    const { wrapPassphrase, unwrapPassphrase } = await import('@/lib/backup');
    const settings = await getBackupSettings();
    if (settings.wrappedPassphrase) {
      const plain = await unwrapPassphrase(settings.wrappedPassphrase, oldMasterKey);
      await saveBackupSettings({
        ...settings,
        wrappedPassphrase: await wrapPassphrase(plain, newMasterKey),
      });
    }
  } catch {
    // 重新包装失败不应阻断主密码修改；用户可在备份页重新填写备份密码
  }
}

/**
 * 恢复出厂设置：校验主密码后清空整个保险库。
 * 会一并删除主密码哈希与盐、全部 API Key、所有登录会话以及所有密码/分类/标签数据，
 * 执行后保险库回到「未初始化」状态，需要重新设置主密码。
 * 要求输入当前主密码，避免仅凭一个被盗会话就能摧毁全部数据。
 */
export async function factoryResetVault(masterPassword: string): Promise<WipeVaultResult> {
  const valid = await verifyMasterPassword(masterPassword);
  if (!valid) {
    throw new AuthenticationError(
      '主密码不正确，无法恢复出厂设置',
      'AUTH_INVALID_PASSWORD'
    );
  }

  return wipeAllVaultData();
}

export interface LoginResult {
  sessionId: string;
  expiresAt: string;
}

export async function loginWithMasterPassword(
  masterPassword: string,
  options?: { durationSeconds?: number }
): Promise<LoginResult> {
  const config = await requireConfig();
  const valid = await verifyMasterPassword(masterPassword);
  if (!valid) {
    throw new AuthenticationError(
      'Master password is incorrect',
      'AUTH_INVALID_PASSWORD'
    );
  }

  const masterKeyRaw = await deriveMasterKeyBytes(
    masterPassword,
    config.masterSalt,
    config.pbkdf2Iterations
  );
  const sessionSecret = generateSalt(32);
  const sessionKey = await importAESKey(new TextEncoder().encode(sessionSecret.padEnd(32, '0').slice(0, 32)));
  const exportable = Array.from(masterKeyRaw).map((b) => b.toString(16).padStart(2, '0')).join('');
  const encryptedMasterKey = await encryptAESGCM(sessionKey, exportable);

  const duration = options?.durationSeconds || Number(process.env.SESSION_DURATION) || 86400;
  const sessionId = generateSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + duration * 1000).toISOString();

  const sessionData: SessionData = {
    sessionId,
    ownerId: 'user_default',
    createdAt: now.toISOString(),
    expiresAt,
    kekSalt: sessionSecret,
    encryptedMasterKey: encryptedMasterKey.ciphertext,
    masterKeyIv: encryptedMasterKey.iv,
    masterKeyTag: encryptedMasterKey.tag,
  };

  await createSession(sessionData, duration);

  return {
    sessionId,
    expiresAt,
  };
}

export async function getValidSession(sessionId: string): Promise<SessionData | null> {
  const session = await getSession(sessionId);
  if (!session) return null;

  const now = new Date();
  if (new Date(session.expiresAt) < now) {
    await deleteSession(sessionId);
    return null;
  }

  return session;
}

export async function logoutSession(sessionId: string): Promise<void> {
  await deleteSession(sessionId);
}

export async function getMasterKeyFromSession(session: SessionData): Promise<CryptoKey> {
  if (!session.encryptedMasterKey || !session.masterKeyIv || !session.masterKeyTag) {
    throw new AuthenticationError('Session missing master key data');
  }
  const secret = session.kekSalt.padEnd(32, '0').slice(0, 32);
  const sessionKey = await importAESKey(new TextEncoder().encode(secret));
  const hex = await decryptAESGCM(
    sessionKey,
    session.masterKeyIv,
    session.encryptedMasterKey,
    session.masterKeyTag
  );
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return importAESKey(bytes);
}

export async function getDefaultOwnerIdFromSession(session: SessionData): Promise<string> {
  return session.ownerId || 'user_default';
}

export { isInitialized };
