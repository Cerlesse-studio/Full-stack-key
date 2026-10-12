import { ValidationError } from '@/lib/errors';

/**
 * Freebuff 备份文件容器格式 v2
 * ---------------------------------------------------------------
 * 单文件、纯文本（便于放进 git 仓库而不产生二进制差异）：
 *
 *   第 1 行  FREEBUFFBK2                     —— 魔数，用于识别格式与版本
 *   第 2 行  { ... }                         —— 单行 JSON 头，只含外层参数与元信息
 *   第 3 行起 base64 正文                     —— 外层密文，按 76 字符折行
 *
 * 两层结构：
 *   外层（传输） 备份密码 → PBKDF2-SHA256 → AES-256-GCM
 *   内层（归属） 管理员密码 + 管理员账号名 → PBKDF2-SHA256 → AES-256-CBC + HMAC-SHA256
 *
 * 两层刻意采用**不同的加密模式**：外层是带认证的对称加密（GCM），
 * 内层是「先加密后认证」的 CBC + HMAC 组合，并把账号名混入密钥派生。
 * 缺少任一凭据都无法取得明文。
 */

export const BACKUP_FILE_MAGIC = 'FREEBUFFBK2';
export const BACKUP_FILE_EXTENSION = '.fbk';
export const BACKUP_CONTAINER_VERSION = 2;

/** 外层：备份密码 + AES-256-GCM */
export interface OuterLayerHeader {
  kdf: { name: 'PBKDF2-SHA256'; iterations: number; salt: string };
  cipher: { name: 'AES-256-GCM'; iv: string; tag: string };
}

/** 内层：管理员密码 + 账号名 → AES-256-CBC + HMAC-SHA256 */
export interface InnerLayerParams {
  kdf: { name: 'PBKDF2-SHA256'; iterations: number; salt: string };
  cipher: { name: 'AES-256-CBC'; iv: string };
  mac: { name: 'HMAC-SHA256'; tag: string };
  plaintextLength: number;
}

/** 外层解密后得到的信封：内层参数与内层密文 */
export interface BackupEnvelope {
  format: 'freebuff-backup-envelope';
  version: number;
  createdAt: string;
  adminUsername: string;
  inner: InnerLayerParams;
  payload: string;
}

/** 文件第 2 行的头部 */
export interface BackupFileHeader {
  format: 'freebuff-backup-v2';
  version: number;
  createdAt: string;
  /** 管理员账号名：明文元信息，同时参与内层密钥派生 */
  adminUsername: string;
  outer: OuterLayerHeader;
  /** 正文 base64 长度（不含换行），用于快速完整性校验 */
  bodyLength: number;
  /** 正文的 SHA-256（十六进制），在跑 KDF 之前就能发现截断或损坏 */
  bodySha256: string;
}

const BODY_LINE_LENGTH = 76;

/** 把 base64 正文折行，便于人工查看与文本工具处理 */
function wrapBody(base64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += BODY_LINE_LENGTH) {
    lines.push(base64.slice(i, i + BODY_LINE_LENGTH));
  }
  return lines.join('\n');
}

export interface ParsedContainer {
  header: BackupFileHeader;
  /** 外层密文的原始 base64 文本 */
  body: string;
}

/** 组装成最终的单文件内容 */
export function serializeContainer(header: BackupFileHeader, body: string): string {
  const normalizedBody = body.replace(/\s+/g, '');
  return (
    `${BACKUP_FILE_MAGIC}\n` +
    `${JSON.stringify(header)}\n` +
    `${wrapBody(normalizedBody)}\n`
  );
}

/**
 * 解析备份文件。
 * 既识别新的单文件容器，也兼容旧版（v1）的纯 JSON 备份文件。
 */
export function parseContainer(text: string): ParsedContainer {
  const trimmed = text.trim();
  if (!trimmed) throw new ValidationError('备份文件为空');

  if (!trimmed.startsWith(BACKUP_FILE_MAGIC)) {
    // 旧版 v1：整体就是 JSON
    try {
      const legacy = JSON.parse(trimmed) as { format?: string };
      if (legacy?.format === 'freebuff-backup-file') {
        throw new ValidationError(
          '这是旧版（v1）备份文件，无法用于两层认证恢复。请在旧版本中重新创建一次备份。'
        );
      }
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError('备份文件不是有效的 Freebuff 备份');
    }
    throw new ValidationError('备份文件格式不正确（缺少文件标识）');
  }

  const firstBreak = trimmed.indexOf('\n');
  if (firstBreak < 0) throw new ValidationError('备份文件不完整：缺少头部');

  let header: BackupFileHeader;
  try {
    header = JSON.parse(trimmed.slice(firstBreak + 1, trimmed.indexOf('\n', firstBreak + 1))) as BackupFileHeader;
  } catch {
    throw new ValidationError('备份文件头部解析失败');
  }

  if (
    !header ||
    header.format !== 'freebuff-backup-v2' ||
    !header.outer?.kdf?.salt ||
    !header.outer?.cipher?.iv
  ) {
    throw new ValidationError('备份文件头部不正确');
  }

  const body = trimmed.slice(trimmed.indexOf('\n', firstBreak + 1) + 1).replace(/\s+/g, '');

  if (body.length !== header.bodyLength) {
    throw new ValidationError('备份文件不完整：正文长度与头部不符，可能在传输中被截断');
  }

  return { header, body };
}

export function isBackupContainer(text: string): boolean {
  return text.trim().startsWith(BACKUP_FILE_MAGIC);
}

/** 备份文件名（UI 导出用） */
export function backupDownloadName(createdAt: string): string {
  const compact = createdAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `freebuff-backup-${compact}${BACKUP_FILE_EXTENSION}`;
}