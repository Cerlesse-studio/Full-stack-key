import { nanoid } from 'nanoid';
import { getStorage } from '@/lib/storage';
import { AppError, ValidationError } from '@/lib/errors';

const PAIRING_PREFIX = 'pm:pairing:';

/** 配对码默认只活 60 秒：够扫一次，不够被人拍下来慢慢试 */
export const PAIRING_TOKEN_TTL_SECONDS = 60;

export interface PairingTokenRecord {
  token: string;
  /** 兑换出来的 API Key 会绑定到这个 ownerId，客户端才能看到同一份数据 */
  ownerId: string;
  createdAt: string;
  expiresAt: string;
  /** 已失败尝试次数，防止有人拿着截到的图穷举（token 本身熵很高，主要是兜底） */
  attempts: number;
}

/** 60 秒 × 10，足够一次正常扫码 + 一次输错重扫 */
const MAX_ATTEMPTS = 10;

function storageKey(token: string): string {
  return PAIRING_PREFIX + token;
}

/** token 只允许出现在 base64url 字符集里，防止有人拿它当键名穿越前缀 */
function assertTokenShape(token: string): string {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(trimmed)) {
    throw new ValidationError('配对码格式不正确');
  }
  return trimmed;
}

export async function createPairingToken(
  ownerId: string,
  ttlSeconds: number = PAIRING_TOKEN_TTL_SECONDS
): Promise<PairingTokenRecord> {
  const storage = getStorage();
  const token = nanoid(32);
  const now = Date.now();
  const record: PairingTokenRecord = {
    token,
    ownerId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
    attempts: 0,
  };

  await storage.put(storageKey(token), record, ttlSeconds);
  return record;
}

/** 只读不删，用于设置页轮询显示剩余有效秒数 */
export async function readPairingToken(token: string): Promise<PairingTokenRecord | null> {
  const storage = getStorage();
  const record = await storage.get<PairingTokenRecord>(storageKey(assertTokenShape(token)));
  if (!record) return null;
  if (Date.parse(record.expiresAt) <= Date.now()) return null;
  return record;
}

export class PairingTokenError extends AppError {
  constructor(message: string, details?: unknown) {
    super('PAIRING_INVALID', message, 400, details);
    this.name = 'PairingTokenError';
  }
}

/**
 * 核销配对码：成功即作废。
 *
 * 注意 Cloudflare KV 没有原子的 read-and-delete，这里存在毫秒级的并发窗口，
 * 理论上同一个码可能被两个请求同时核销成功。token 是 32 位随机、且 60 秒即过期，
 * 实际风险可以忽略；真要严格一致应该换成 Durable Object 或 D1 的唯一索引。
 */
export async function consumePairingToken(token: string): Promise<PairingTokenRecord> {
  const storage = getStorage();
  const key = storageKey(assertTokenShape(token));
  const record = await storage.get<PairingTokenRecord>(key);

  if (!record) {
    throw new PairingTokenError('配对码不存在、已被使用或已过期');
  }

  await storage.delete(key);

  if (Date.parse(record.expiresAt) <= Date.now()) {
    throw new PairingTokenError('配对码已过期，请在电脑上重新生成');
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    throw new PairingTokenError('配对码尝试次数过多，请重新生成');
  }

  return record;
}

/** 记录一次失败尝试，配对码本身会被打上次数 */
export async function markPairingAttempt(token: string): Promise<void> {
  const storage = getStorage();
  const key = storageKey(assertTokenShape(token));
  const record = await storage.get<PairingTokenRecord>(key);
  if (!record) return;
  const ttlSeconds = Math.max(
    1,
    Math.ceil((Date.parse(record.expiresAt) - Date.now()) / 1000)
  );
  await storage.put(key, { ...record, attempts: record.attempts + 1 }, ttlSeconds);
}
