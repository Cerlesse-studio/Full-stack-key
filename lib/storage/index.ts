import type { KVStorage, KVStorageOptions, StorageInfo } from './types';
import { storageAdapterManager } from './adapter';

export function getStorage(bindingNameOrOptions?: string | KVStorageOptions): KVStorage {
  return storageAdapterManager.getStorage(bindingNameOrOptions);
}

/** 单次列举的页数上限，防止游标异常时死循环（1000 条/页 -> 最多 10 万键） */
const MAX_LIST_PAGES = 100;

/**
 * 获取前缀下的全部键，自动跟进 Cloudflare KV 的游标翻页。
 * memory / sqlite 存储一次返回全部结果，不会进入翻页分支。
 */
export async function listAllKeys(prefix?: string): Promise<string[]> {
  const storage = getStorage();
  const keys: string[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await storage.list(prefix, cursor);
    keys.push(...result.keys);
    if (result.list_complete || !result.cursor || result.cursor === cursor) break;
    cursor = result.cursor;
  }

  return keys;
}

export function getStorageInfo(bindingNameOrOptions?: string | KVStorageOptions): StorageInfo {
  return storageAdapterManager.getStorageInfo(bindingNameOrOptions);
}

export function getStorageStats(bindingNameOrOptions?: string | KVStorageOptions): Promise<{
  fileSizeBytes: number;
  totalKeys: number;
  estimatedPayloadBytes: number;
}> {
  return storageAdapterManager.getStorageStats(bindingNameOrOptions);
}

export function getDetailedDatabaseStats(bindingNameOrOptions?: string | KVStorageOptions) {
  return storageAdapterManager.getDetailedDatabaseStats(bindingNameOrOptions);
}

export function resetStorageForTesting(): void {
  storageAdapterManager.reset();
}

export type {
  KVStorage,
  KVStorageOptions,
  StorageDriverType,
  ResolvedStorageDriver,
  EnvironmentType,
  StorageInfo,
} from './types';

export { MemoryKVStorage, memoryKV } from './memoryKV';
export { CloudflareKVStorage } from './cloudflareKV';
export { SQLiteKVStorage } from './sqliteKV';
export {
  detectEnvironment,
  resolveStorageDriver,
  StorageAdapterManager,
  storageAdapterManager,
} from './adapter';
