import { localSupported, putLocal, getLocal, removeLocal } from './local';
import { putDatabase, getDatabase, removeDatabase } from './database';
import { putGit, getGit, removeGit, testGit, gitConfigured } from './git';
import { ValidationError } from '@/lib/errors';
import type { BackupCapabilities, BackupTarget } from '../types';

interface TargetAdapter {
  put(
    recordId: string,
    createdAt: string,
    reason: string,
    serialized: string
  ): Promise<{ location: string; size: number }>;
  get(location: string): Promise<string>;
  remove(location: string): Promise<void>;
  test?(): Promise<{ ok: boolean; detail: string }>;
  /** 当前环境是否可用 */
  available(): boolean;
}

const adapters: Record<BackupTarget, TargetAdapter> = {
  database: {
    put: (id, _at, _reason, body) => putDatabase(id, body),
    get: (loc) => getDatabase(loc),
    remove: (loc) => removeDatabase(loc),
    available: () => true,
  },
  local: {
    put: (id, at, reason, body) => putLocal(id, at, reason, body),
    get: (loc) => getLocal(loc),
    remove: (loc) => removeLocal(loc),
    available: localSupported,
  },
  git: {
    put: (id, at, reason, body) => putGit(id, at, reason, body),
    get: (loc) => getGit(loc),
    remove: (loc) => removeGit(loc),
    test: testGit,
    available: gitConfigured,
  },
};

export function getAdapter(target: BackupTarget): TargetAdapter {
  const adapter = adapters[target];
  if (!adapter) throw new ValidationError(`未知的备份目标：${target}`);
  return adapter;
}

/** 目标在当前环境是否可用（未配置凭据 / 无文件系统时不可用） */
export function targetAvailable(target: BackupTarget): boolean {
  return adapters[target].available();
}

export function getCapabilities(): BackupCapabilities {
  const local = localSupported();
  return {
    database: true,
    local,
    git: true,
    gitConfigured: gitConfigured(),
  };
}

export async function testTarget(target: BackupTarget): Promise<{ ok: boolean; detail: string }> {
  const adapter = getAdapter(target);
  if (!adapter.test) {
    return adapter.available()
      ? { ok: true, detail: '目标可用（无需连接测试）' }
      : { ok: false, detail: '当前环境不支持该目标' };
  }
  return adapter.test();
}

export type { TargetAdapter };
