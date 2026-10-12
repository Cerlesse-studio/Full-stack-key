/** 备份功能相关类型定义 */

/** 备份目标：本地文件 / 库内快照 / git 仓库 */
export type BackupTarget = 'local' | 'database' | 'git';

export const BACKUP_TARGETS: BackupTarget[] = ['database', 'local', 'git'];

export const BACKUP_TARGET_LABELS: Record<BackupTarget, string> = {
  database: '数据库内快照',
  local: '本地文件',
  git: 'git 仓库',
};

/** 备份发起原因 */
export type BackupReason = 'manual' | 'auto' | 'pre-reset';

/** 备份元数据（存于存储中，不含密文） */
export interface BackupRecord {
  id: string;
  /** 备份内容版本，便于后续演进 */
  version: number;
  createdAt: string;
  reason: BackupReason;
  /** 内容概要，便于列表展示而不必解密 */
  summary: {
    passwords: number;
    tags: number;
    /** 是否包含主密码哈希与 API 密钥 */
    includesSecrets: boolean;
    adminUsername?: string;
  };
  /** 密文大小（字节） */
  size: number;
  /** 密文 SHA-256，用于完整性校验 */
  checksum: string;
  /** 各目标的结果：目标 -> 存放位置 / 错误 */
  deliveries: BackupDelivery[];
}

export interface BackupDelivery {
  target: BackupTarget;
  ok: boolean;
  /** 存放位置：本地路径、对象 key、库内键 */
  location: string;
  size?: number;
  error?: string;
  at: string;
}

/**
 * 内层明文：只有「管理员密码 + 管理员账号名」能解开。
 *
 * 特别注意：这里**不再包含 masterPasswordHash**。
 * 旧版备份会带上主密码哈希，导致任何拿到备份文件 + 备份密码的人
 * 都能把服务端主密码改成自己知道的值。现在恢复必须先证明知道管理员密码，
 * 条目在导入时会用当前保险库的密钥重新加密，因此无需也不应恢复主密码哈希。
 */
export interface BackupSecret {
  format: 'freebuff-backup-secret';
  version: number;
  createdAt: string;
  /** 管理员账号名，同时参与内层密钥派生 */
  adminUsername: string;
  /** 保险库数据（与导出 JSON 结构一致） */
  vault: {
    passwords: unknown[];
    tags: unknown[];
    /** 旧版备份里的分类字段，导入时会转成同名标签 */
    categories?: unknown[];
  };
  /** 解密条目所必需的来源保险库密钥参数 */
  crypto: {
    /** 来源保险库的主盐 */
    masterSalt: string;
    pbkdf2Iterations: number;
  };
  /** includeSecrets=true 时携带的 API 密钥（已在内层保护下） */
  apiKeys?: unknown[];
  /** 是否携带了 API 密钥 */
  includesSecrets: boolean;
}

/** @deprecated 旧版 v1 明文结构，仅用于给出可读的升级提示 */
export type BackupPayload = {
  format: 'freebuff-backup';
  version: number;
  createdAt: string;
  vault: { passwords: unknown[]; tags: unknown[]; categories?: unknown[] };
  config?: Record<string, unknown>;
  includesSecrets: boolean;
};

/** 备份密码经主密钥包装后的密文（用于自动备份时解包） */
export interface WrappedPassphrase {
  ciphertext: string;
  iv: string;
  tag: string;
}

/** 自动备份设置 */
export interface BackupSettings {
  enabled: boolean;
  /** 自动备份间隔（小时） */
  intervalHours: number;
  /** 自动备份推送到哪些目标 */
  targets: BackupTarget[];
  /** 每个目标保留的自动备份份数 */
  retention: number;
  /** 是否包含主密码哈希与 API 密钥（加密后存放，默认包含） */
  includeSecrets: boolean;
  /** 已保存的备份密码（用会话主密钥包装，供自动备份解包） */
  wrappedPassphrase?: WrappedPassphrase;
  /** 上次自动备份时间 */
  lastRunAt?: string;
  /** 上次自动备份结果摘要 */
  lastResult?: string;
  updatedAt?: string;
}

/** 目标连接配置（凭据来自环境变量，不落库） */
export interface BackupTargetConfig {
  git?: {
    provider: 'github' | 'gitlab';
    baseUrl: string;
    repo: string;
    branch: string;
    directory: string;
  };
  local?: {
    directory: string;
  };
}

export interface BackupCapabilities {
  /** 当前运行时是否支持写入本地文件（Cloudflare Workers 不支持） */
  local: boolean;
  /** git 仓库目标在任何运行时都可用（走 HTTP API） */
  git: boolean;
  database: true;
  /** 是否配置了 git 仓库凭据 */
  gitConfigured: boolean;
}

export interface CreateBackupResult {
  record: BackupRecord;
  /** 是否有目标失败 */
  partial: boolean;
}

export interface RestoreResult {
  passwords: { imported: number; skipped: number; overwritten: number; duplicated: number };
  tagsCreated: number;
  /** 是否同时恢复了 API 密钥等配置（主密码永不再被覆盖） */
  configRestored: boolean;
  warnings: string[];
}

/** 备份文件的两层认证凭据 */
export interface BackupCredentials {
  /** 外层：备份密码 */
  passphrase: string;
  /** 内层：管理员密码 */
  adminPassword: string;
}
