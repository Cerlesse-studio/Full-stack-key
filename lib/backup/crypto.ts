import { encryptAESGCM, decryptAESGCM, generateSalt } from '@/lib/crypto';
import type { EncryptedData } from '@/lib/crypto';
import { EncryptionError, DecryptionError, ValidationError } from '@/lib/errors';
import {
  BACKUP_CONTAINER_VERSION,
  serializeContainer,
  parseContainer,
  type BackupEnvelope,
  type BackupFileHeader,
  type InnerLayerParams,
} from './fileFormat';
import type { BackupSecret } from './types';

/**
 * 备份文件的两层加密。
 *
 * 外层（传输）备份密码 → PBKDF2-SHA256 → AES-256-GCM
 * 内层（归属）管理员密码 + 管理员账号名 → PBKDF2-SHA256 → AES-256-CBC + HMAC-SHA256
 *
 * 两层使用不同的加密模式与不同的密钥来源：
 * - GCM 自带认证标签，内层改为「先加密后认证」的 CBC + HMAC 组合，
 *   HMAC 覆盖头部与 IV，可防止把 A 文件的密文拼到 B 文件上；
 * - 内层密钥把管理员账号名一起混入派生，账号名被改动即无法解密，
 *   也防止把某个账号的备份当成另一个账号的来解开。
 */

/** 备份密码最短长度（与主密码要求一致） */
export const MIN_BACKUP_PASSPHRASE_LENGTH = 8;
/** 备份密码最短长度 */
export const MIN_ADMIN_PASSWORD_LENGTH = 8;
/** 两层各自的 PBKDF2 迭代次数 */
export const BACKUP_KDF_ITERATIONS = 200000;

const AES_CBC_IV_BYTES = 16;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function encodeBase64(bytes: Uint8Array): string {
  return toBase64(bytes);
}

export function decodeBase64(b64: string): Uint8Array {
  return fromBase64(b64);
}

export function assertBackupPassphrase(passphrase: string | undefined | null): void {
  if (passphrase === undefined || passphrase === null || passphrase === '') {
    throw new ValidationError(
      '缺少备份密码：请提供第 1 层的备份密码',
      { field: 'backupPassphrase' }
    );
  }
  if (passphrase.length < MIN_BACKUP_PASSPHRASE_LENGTH) {
    throw new ValidationError(
      `备份密码至少 ${MIN_BACKUP_PASSPHRASE_LENGTH} 个字符（当前 ${passphrase.length} 个）`,
      { field: 'backupPassphrase' }
    );
  }
}

export function assertAdminPassword(password: string | undefined | null): void {
  // 「没传」和「太短」是两回事，报错必须分开说，
  // 否则用户会看到「至少 8 个字符」却发现自己明明输入了足够长的内容。
  if (password === undefined || password === null || password === '') {
    throw new ValidationError(
      '缺少管理员密码：备份已启用两层认证，需要提供管理员密码（即保险库主密码）',
      { field: 'adminPassword' }
    );
  }
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new ValidationError(
      `管理员密码至少 ${MIN_ADMIN_PASSWORD_LENGTH} 个字符（当前 ${password.length} 个）`,
      { field: 'adminPassword' }
    );
  }
}

// ---------------------------------------------------------------- 外层

async function deriveOuterKey(
  passphrase: string,
  salt: string,
  iterations: number
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase) as unknown as BufferSource,
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromHex(salt) as unknown as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ---------------------------------------------------------------- 内层

/**
 * 内层密钥对：PBKDF2 一次派生 64 字节，前 32 字节作 AES 密钥，
 * 后 32 字节作 HMAC 密钥（避免用同一把密钥同时加密与认证）。
 */
async function deriveInnerKeyPair(
  adminPassword: string,
  adminUsername: string,
  salt: string,
  iterations: number
): Promise<{ cipherKey: CryptoKey; macKey: CryptoKey }> {
  const material = new TextEncoder().encode(`${adminPassword}\u0000${adminUsername}`);
  const baseKey = await crypto.subtle.importKey(
    'raw',
    material as unknown as BufferSource,
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(salt) as unknown as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    512
  );
  const all = new Uint8Array(bits);
  const cipherKey = await crypto.subtle.importKey(
    'raw',
    all.subarray(0, 32) as unknown as BufferSource,
    { name: 'AES-CBC' },
    false,
    ['encrypt', 'decrypt']
  );
  const macKey = await crypto.subtle.importKey(
    'raw',
    all.subarray(32, 64) as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  return { cipherKey, macKey };
}

/** 内层 HMAC 覆盖的内容：头部 + IV + 密文，任何一处被改动都会验签失败 */
function innerAad(header: {
  version: number;
  createdAt: string;
  adminUsername: string;
}): Uint8Array {
  return new TextEncoder().encode(
    `freebuff-inner-v${header.version}|${header.createdAt}|${header.adminUsername}`
  );
}

async function hmac(macKey: CryptoKey, parts: Uint8Array[]): Promise<Uint8Array> {
  let total = 0;
  for (const p of parts) total += p.length;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    joined.set(p, offset);
    offset += p.length;
  }
  const sig = await crypto.subtle.sign('HMAC', macKey, joined as unknown as BufferSource);
  return new Uint8Array(sig);
}

/** 定长比较，避免通过响应时间泄露信息 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** 用管理员密码 + 账号名加密明文，产出内层密文与参数 */
export async function sealInnerLayer(
  plaintext: string,
  adminPassword: string,
  adminUsername: string,
  bound: { version: number; createdAt: string }
): Promise<{ payload: string; params: InnerLayerParams }> {
  assertAdminPassword(adminPassword);
  const salt = generateSalt();
  const { cipherKey, macKey } = await deriveInnerKeyPair(
    adminPassword,
    adminUsername,
    salt,
    BACKUP_KDF_ITERATIONS
  );

  const iv = new Uint8Array(AES_CBC_IV_BYTES);
  crypto.getRandomValues(iv);
  const data = new TextEncoder().encode(plaintext);

  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: iv as unknown as BufferSource },
      cipherKey,
      data as unknown as BufferSource
    );
  } catch (err) {
    throw new EncryptionError(
      '内层加密失败',
      err instanceof Error ? err.message : String(err)
    );
  }

  const tag = await hmac(macKey, [
    innerAad({ ...bound, adminUsername }),
    iv,
    new Uint8Array(ciphertext),
  ]);

  return {
    payload: toBase64(new Uint8Array(ciphertext)),
    params: {
      kdf: { name: 'PBKDF2-SHA256', iterations: BACKUP_KDF_ITERATIONS, salt },
      cipher: { name: 'AES-256-CBC', iv: toBase64(iv) },
      mac: { name: 'HMAC-SHA256', tag: toHex(tag) },
      plaintextLength: data.length,
    },
  };
}

/** 校验并解开内层；管理员密码或账号名不对时抛 DecryptionError */
export async function openInnerLayer(
  envelope: BackupEnvelope,
  adminPassword: string,
  adminUsername: string
): Promise<BackupSecret> {
  assertAdminPassword(adminPassword);
  const { cipherKey, macKey } = await deriveInnerKeyPair(
    adminPassword,
    adminUsername,
    envelope.inner.kdf.salt,
    envelope.inner.kdf.iterations
  );

  const iv = fromBase64(envelope.inner.cipher.iv);
  const ciphertext = fromBase64(envelope.payload);
  const expectedTag = fromHexSafe(envelope.inner.mac.tag);
  if (!expectedTag) throw new DecryptionError('备份文件损坏：内层认证标签格式不正确');

  const actualTag = await hmac(macKey, [
    innerAad({
      version: envelope.version,
      createdAt: envelope.createdAt,
      adminUsername,
    }),
    iv,
    ciphertext,
  ]);
  if (!timingSafeEqual(actualTag, expectedTag)) {
    throw new DecryptionError('管理员密码或账号名不正确，无法解开备份内层');
  }

  let plaintext: string;
  try {
    const buf = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: iv as unknown as BufferSource },
      cipherKey,
      ciphertext as unknown as BufferSource
    );
    plaintext = new TextDecoder().decode(new Uint8Array(buf));
  } catch {
    throw new DecryptionError('备份内层解密失败，文件可能已损坏');
  }

  if (envelope.inner.plaintextLength !== undefined) {
    const actual = new TextEncoder().encode(plaintext).length;
    if (actual !== envelope.inner.plaintextLength) {
      throw new DecryptionError('备份内容长度异常，文件可能已损坏');
    }
  }

  try {
    return JSON.parse(plaintext) as BackupSecret;
  } catch {
    throw new DecryptionError('备份内容不是合法的 JSON');
  }
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function fromHexSafe(hex: string): Uint8Array | null {
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

// ---------------------------------------------------------------- 组合

/**
 * 双层封装：先内层（管理员密码），再外层（备份密码），最后装进单文件容器。
 */
export async function sealBackupFile(
  secret: BackupSecret,
  credentials: { passphrase: string; adminPassword: string }
): Promise<string> {
  assertBackupPassphrase(credentials.passphrase);
  assertAdminPassword(credentials.adminPassword);
  if (!secret.adminUsername?.trim()) {
    throw new ValidationError('缺少管理员账号名，无法生成内层密钥');
  }

  const bound = { version: secret.version, createdAt: secret.createdAt };
  const inner = await sealInnerLayer(
    JSON.stringify(secret),
    credentials.adminPassword,
    secret.adminUsername,
    bound
  );

  const envelope: BackupEnvelope = {
    format: 'freebuff-backup-envelope',
    version: secret.version,
    createdAt: secret.createdAt,
    adminUsername: secret.adminUsername,
    inner: inner.params,
    payload: inner.payload,
  };

  const outerSalt = generateSalt();
  const outerKey = await deriveOuterKey(
    credentials.passphrase,
    outerSalt,
    BACKUP_KDF_ITERATIONS
  );

  let enc: EncryptedData;
  try {
    enc = await encryptAESGCM(outerKey, JSON.stringify(envelope));
  } catch (err) {
    throw new EncryptionError(
      '外层加密失败',
      err instanceof Error ? err.message : String(err)
    );
  }

  const body = enc.ciphertext;
  const header: BackupFileHeader = {
    format: 'freebuff-backup-v2',
    version: BACKUP_CONTAINER_VERSION,
    createdAt: secret.createdAt,
    adminUsername: secret.adminUsername,
    outer: {
      kdf: { name: 'PBKDF2-SHA256', iterations: BACKUP_KDF_ITERATIONS, salt: outerSalt },
      cipher: { name: 'AES-256-GCM', iv: enc.iv, tag: enc.tag },
    },
    bodyLength: body.length,
    bodySha256: await sha256Hex(body),
  };

  return serializeContainer(header, body);
}

export interface OpenedContainer {
  header: BackupFileHeader;
  envelope: BackupEnvelope;
}

/**
 * 第一步：解开外层（需要备份密码）。
 * 备份密码错误时 GCM 认证标签校验失败。
 */
export async function openBackupFile(text: string, passphrase: string): Promise<OpenedContainer> {
  if (!passphrase || passphrase.length < MIN_BACKUP_PASSPHRASE_LENGTH) {
    throw new ValidationError('备份密码错误', { field: 'backupPassphrase' });
  }

  const { header, body } = parseContainer(text);

  const actual = await sha256Hex(body);
  if (header.bodySha256 && actual !== header.bodySha256) {
    throw new DecryptionError('备份文件校验失败，内容可能在传输中被篡改');
  }

  const key = await deriveOuterKey(passphrase, header.outer.kdf.salt, header.outer.kdf.iterations);

  let plaintext: string;
  try {
    plaintext = await decryptAESGCM(key, header.outer.cipher.iv, body, header.outer.cipher.tag);
  } catch {
    throw new DecryptionError('备份密码错误，或文件已损坏');
  }

  let envelope: BackupEnvelope;
  try {
    envelope = JSON.parse(plaintext) as BackupEnvelope;
  } catch {
    throw new DecryptionError('备份内容解析失败');
  }
  if (envelope?.format !== 'freebuff-backup-envelope' || !envelope.inner) {
    throw new DecryptionError('备份信封结构不正确');
  }
  return { header, envelope };
}

/** 只读解析头部（用于列表展示归属与格式判断，不触发任何 KDF） */
export function readContainerHeader(text: string): BackupFileHeader {
  return parseContainer(text).header;
}

/** 计算文本的 SHA-256（十六进制），用于完整性校验 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text) as unknown as BufferSource
  );
  return toHex(new Uint8Array(digest));
}