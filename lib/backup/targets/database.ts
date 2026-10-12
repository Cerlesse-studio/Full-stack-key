import { getStorage } from '@/lib/storage';
import type { BackupTarget } from '../types';

const PREFIX = 'pm:__backup_blob__:';

export function blobKey(recordId: string): string {
  return `${PREFIX}${recordId}`;
}

export async function putDatabase(recordId: string, serialized: string): Promise<{ location: string; size: number }> {
  const storage = getStorage();
  const key = blobKey(recordId);
  // 快照不加 TTL：它必须比数据活得更久，否则失去备份意义
  await storage.put(key, serialized);
  return { location: key, size: serialized.length };
}

export async function getDatabase(location: string): Promise<string> {
  const storage = getStorage();
  const value = await storage.get<string | { serialized?: string }>(location);
  if (value === null || value === undefined) {
    throw new Error('库内快照不存在或已过期');
  }
  if (typeof value === 'string') return value;
  if (typeof (value as { serialized?: string }).serialized === 'string') {
    return (value as { serialized: string }).serialized;
  }
  // 某些存储实现会自动 JSON.parse 字符串，这里兜底重新序列化
  return JSON.stringify(value);
}

export async function removeDatabase(location: string): Promise<void> {
  const storage = getStorage();
  await storage.delete(location);
}

export const databaseTarget: BackupTarget = 'database';
