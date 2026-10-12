import type { BackupTarget } from '../types';

export interface TargetResult {
  location: string;
  size: number;
}

/** 备份文件名：backup-20261002T140530Z-ab12cd.json */
export function backupFileName(recordId: string, createdAt: string, reason: string): string {
  const compact = createdAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `freebuff-${reason}-${compact}-${recordId.slice(0, 8)}.json`;
}

export function localSupported(): boolean {
  return typeof process !== 'undefined' && !!process.versions?.node;
}

function resolveDir(): string {
  return process.env.BACKUP_LOCAL_DIR || 'backups';
}

export async function putLocal(
  recordId: string,
  createdAt: string,
  reason: string,
  serialized: string
): Promise<TargetResult> {
  if (!localSupported()) {
    throw new Error('当前运行时不支持写入本地文件（Cloudflare 环境请改用 git 仓库 / 数据库快照）');
  }
  const fs = await import('node:fs');
  const path = await import('node:path');

  // turbopackIgnore: 备份目录可由 BACKUP_LOCAL_DIR 指定，静态分析无法收敛，
  // 否则会把整个项目（含 public）都打进 Worker 产物。
  const dir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), resolveDir());
  await fs.promises.mkdir(dir, { recursive: true });

  const file = path.join(dir, backupFileName(recordId, createdAt, reason));
  await fs.promises.writeFile(file, serialized, 'utf-8');

  return { location: file, size: Buffer.byteLength(serialized, 'utf-8') };
}

export async function getLocal(location: string): Promise<string> {
  const fs = await import('node:fs');
  return fs.promises.readFile(location, 'utf-8');
}

export async function removeLocal(location: string): Promise<void> {
  const fs = await import('node:fs');
  await fs.promises.unlink(location).catch(() => {});
}

export const localTarget: BackupTarget = 'local';
