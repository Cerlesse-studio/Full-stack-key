export interface KVStorage {
  get<T = unknown>(key: string): Promise<T | null>;
  put<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * 列举键。Cloudflare KV 单页最多 1000 条，需要翻页时请传入上一次的 cursor
   * （memory / sqlite 一次性返回全部，忽略 cursor 参数）。
   */
  list(
    prefix?: string,
    cursor?: string
  ): Promise<{ keys: string[]; list_complete: boolean; cursor?: string }>;
}

export type StorageDriverType =
  | 'auto'
  | 'sqlite'
  | 'cloudflare'
  | 'cloudflare-kv'
  | 'memory';

export type ResolvedStorageDriver = 'sqlite' | 'cloudflare' | 'memory';

export type EnvironmentType =
  | 'cloudflare'
  | 'node'
  | 'edge'
  | 'browser'
  | 'unknown';

export interface StorageInfo {
  driver: ResolvedStorageDriver;
  configuredType: string;
  environment: EnvironmentType;
  isPersistent: boolean;
  details: {
    dbPath?: string;
    bindingName?: string;
    description: string;
    fallbackReason?: string;
  };
}

export interface KVStorageOptions {
  bindingName?: string;
  namespaceId?: string;
  storageType?: StorageDriverType;
  dbPath?: string;
  forceNew?: boolean;
}
