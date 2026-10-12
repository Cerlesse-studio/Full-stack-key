export interface PasswordEntry {
  id: string;
  site: string;
  url?: string;
  username: string;
  encryptedPassword: string;
  encryptedNotes?: string;
  passwordIv: string;
  passwordTag: string;
  notesIv?: string;
  notesTag?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  version: number;
  trashed: boolean;
  trashedAt?: string;
}

export type EncryptedPasswordEntry = PasswordEntry;

export interface PasswordEntryDecrypted extends Omit<PasswordEntry, 'encryptedPassword' | 'encryptedNotes' | 'passwordIv' | 'passwordTag' | 'notesIv' | 'notesTag'> {
  password: string;
  notes?: string;
}

export interface PasswordEntryInput {
  site: string;
  url?: string;
  username?: string;
  password: string;
  notes?: string;
  tags?: string[];
}

export interface PasswordEntryUpdate {
  site?: string;
  url?: string;
  username?: string;
  password?: string;
  notes?: string;
  tags?: string[];
  version: number;
}

export interface Tag {
  id: string;
  name: string;
  color?: string;
  createdAt: string;
}

/**
 * 旧版（分类与标签并存）的数据形态。
 * 分类已合并为标签，这里只用于一次性迁移与旧导出/旧备份的兼容读取。
 */
export interface LegacyCategory {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export type LegacyPasswordEntry = PasswordEntry & { categoryId?: string };

export type LegacyExportData = Omit<ExportData, 'categories' | 'tags'> & {
  categories?: LegacyCategory[];
  tags?: unknown[];
};

export interface ApiKey {
  id: string;
  keyHash: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  revoked: boolean;
  /**
   * 这把 Key 所属的保险库归属。
   * 旧版本没有这个字段，读取时回退到 `user_<apiKeyId 前 12 位>`；
   * 扫码配对产生的 Key 会显式写入同一个 ownerId，客户端才能看到同一份数据。
   */
  ownerId?: string;
}

export interface AppConfig {
  initialized: boolean;
  masterPasswordHash: string;
  masterSalt: string;
  kekSalt: string;
  pbkdf2Iterations: number;
  createdAt: string;
  apiKeys: ApiKey[];
  /**
   * 管理员账号名称，创建保险库时必填。
   * 旧版本创建的保险库没有该字段，读取时需容忍 undefined。
   */
  adminUsername?: string;
}

export interface PaginationParams {
  page?: number;
  perPage?: number;
}

export interface PasswordListParams extends PaginationParams {
  search?: string;
  tag?: string;
  trashed?: boolean;
  sortBy?: 'updatedAt_desc' | 'updatedAt_asc' | 'site_asc' | 'site_desc' | 'createdAt_desc';
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}

export interface SyncResponse {
  created: PasswordEntry[];
  updated: PasswordEntry[];
  deleted: PasswordEntry[];
  syncedAt: string;
}

export interface ImportOptions {
  strategy: 'skip' | 'overwrite' | 'duplicate';
}

export interface ExportData {
  version: string;
  exportedAt: string;
  tags: Tag[];
  passwords: PasswordEntry[];
}
