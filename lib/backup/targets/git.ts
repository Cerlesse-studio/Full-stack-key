import { backupFileName } from './local';
import type { BackupTarget } from '../types';

/**
 * git 仓库备份目标（GitHub / GitLab 的 HTTP API）。
 *
 * 刻意不调用本地 git 命令：Cloudflare Workers 没有 git 二进制，
 * HTTP API 在 Node 与 Workers 上行为一致，且无需引入任何依赖。
 * 落盘内容是已加密的备份文件（备份密码独立于主密码）。
 */

export type GitProvider = 'github' | 'gitlab';

export interface GitConfig {
  provider: GitProvider;
  /** API 根地址；留空则用官方地址，可指向 GitHub Enterprise / 自建 GitLab */
  baseUrl: string;
  /** 仓库标识：GitHub 为 owner/repo，GitLab 为 group/project（可含子组） */
  repo: string;
  token: string;
  branch: string;
  /** 仓库内存放备份的子目录 */
  directory: string;
  authorName: string;
  authorEmail: string;
}

const DEFAULT_GITHUB_API = 'https://api.github.com';
const DEFAULT_GITLAB_API = 'https://gitlab.com/api/v4';

export function gitConfigured(): boolean {
  return Boolean(process.env.BACKUP_GIT_REPO && process.env.BACKUP_GIT_TOKEN);
}

export function getGitConfig(): GitConfig {
  const provider: GitProvider =
    (process.env.BACKUP_GIT_PROVIDER || '').toLowerCase() === 'gitlab' ? 'gitlab' : 'github';
  const fallback = provider === 'gitlab' ? DEFAULT_GITLAB_API : DEFAULT_GITHUB_API;
  return {
    provider,
    baseUrl: (process.env.BACKUP_GIT_BASE_URL || fallback).replace(/\/+$/, ''),
    repo: process.env.BACKUP_GIT_REPO || '',
    token: process.env.BACKUP_GIT_TOKEN || '',
    branch: process.env.BACKUP_GIT_BRANCH || 'main',
    directory: (process.env.BACKUP_GIT_PATH || 'freebuff-backups').replace(/^\/+|\/+$/g, ''),
    authorName: process.env.BACKUP_GIT_AUTHOR_NAME || 'Freebuff Backup',
    authorEmail: process.env.BACKUP_GIT_AUTHOR_EMAIL || 'backup@freebuff.local',
  };
}

/** 仓库内文件路径（不含目录前缀） */
function repoPath(cfg: GitConfig, file: string): string {
  return cfg.directory ? `${cfg.directory}/${file}` : file;
}

function headers(cfg: GitConfig): Record<string, string> {
  const base: Record<string, string> = {
    Authorization: `Bearer ${cfg.token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'freebuff-backup',
  };
  if (cfg.provider === 'gitlab') return base;
  return {
    ...base,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** 文件内容的 API 地址（写入/读取都用它，作为 backup 的 location） */
function fileApiUrl(cfg: GitConfig, file: string): string {
  const path = repoPath(cfg, file);
  if (cfg.provider === 'gitlab') {
    // GitLab 的 file_path 需要把斜杠一起编码
    const project = encodeURIComponent(cfg.repo);
    return `${cfg.baseUrl}/projects/${project}/repository/files/${encodeURIComponent(path)}`;
  }
  const segments = path.split('/').map(encodeURIComponent).join('/');
  return `${cfg.baseUrl}/repos/${cfg.repo}/contents/${segments}`;
}

/** 读取文件时的地址：两家 API 都用 ref 指定分支 */
function fileReadUrl(cfg: GitConfig, file: string): string {
  return `${fileApiUrl(cfg, file)}?ref=${encodeURIComponent(cfg.branch)}`;
}

function repoApiUrl(cfg: GitConfig): string {
  return cfg.provider === 'gitlab'
    ? `${cfg.baseUrl}/projects/${encodeURIComponent(cfg.repo)}`
    : `${cfg.baseUrl}/repos/${cfg.repo}`;
}

/** UTF-8 字节数（与本地文件目标保持一致，不依赖 Buffer） */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(b64: string): string {
  const binary = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function commitMessage(reason: string, createdAt: string): string {
  return `backup(${reason}): ${createdAt}`;
}

async function readError(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown };
    const msg = typeof parsed.message === 'string' ? parsed.message : parsed.error;
    return typeof msg === 'string' ? msg : raw;
  } catch {
    return raw;
  }
}

/** 读取文件原始内容（不存在时返回 null） */
async function fetchRaw(cfg: GitConfig, file: string): Promise<string | null> {
  const res = await fetch(fileReadUrl(cfg, file), { headers: headers(cfg) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`读取失败 (HTTP ${res.status})：${await readError(res)}`);

  const data = (await res.json()) as {
    content?: string;
    encoding?: string;
    sha?: string;
  };
  if (data.encoding === 'base64' && typeof data.content === 'string') {
    return fromBase64(data.content);
  }
  if (typeof data.content === 'string') return data.content;
  // 大文件场景 GitHub 不返回 content，需要走 blob 接口
  if (data.sha) {
    const blobUrl = `${cfg.baseUrl}/repos/${cfg.repo}/git/blobs/${data.sha}`;
    const blobRes = await fetch(blobUrl, { headers: headers(cfg) });
    if (!blobRes.ok) throw new Error(`读取 blob 失败 (HTTP ${blobRes.status})`);
    const blob = (await blobRes.json()) as { content?: string };
    return blob.content ? fromBase64(blob.content) : '';
  }
  throw new Error('无法解析仓库返回的文件内容');
}

/** 取出已存在文件的 sha（GitHub 删除、GitLab 更新需要） */
async function fetchSha(cfg: GitConfig, file: string): Promise<string | null> {
  const res = await fetch(fileReadUrl(cfg, file), { headers: headers(cfg) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`读取文件信息失败 (HTTP ${res.status})：${await readError(res)}`);
  const data = (await res.json()) as { sha?: string; last_commit_id?: string };
  return data.sha ?? data.last_commit_id ?? null;
}

export async function putGit(
  recordId: string,
  createdAt: string,
  reason: string,
  serialized: string
): Promise<{ location: string; size: number }> {
  const cfg = getGitConfig();
  if (!cfg.repo || !cfg.token) throw new Error('未配置 BACKUP_GIT_REPO / BACKUP_GIT_TOKEN');

  const file = backupFileName(recordId, createdAt, reason);
  const content = toBase64(serialized);
  const message = commitMessage(reason, createdAt);

  let res: Response;
  if (cfg.provider === 'gitlab') {
    res = await fetch(fileApiUrl(cfg, file), {
      method: 'PUT',
      headers: headers(cfg),
      body: JSON.stringify({
        branch: cfg.branch,
        content,
        encoding: 'base64',
        commit_message: message,
        author_name: cfg.authorName,
        author_email: cfg.authorEmail,
      }),
    });
  } else {
    res = await fetch(fileApiUrl(cfg, file), {
      method: 'PUT',
      headers: headers(cfg),
      body: JSON.stringify({
        message,
        content,
        branch: cfg.branch,
        author: { name: cfg.authorName, email: cfg.authorEmail },
        committer: { name: cfg.authorName, email: cfg.authorEmail },
      }),
    });
  }

  if (!res.ok) {
    throw new Error(`git 仓库提交失败 (HTTP ${res.status})：${await readError(res)}`);
  }
  return { location: fileApiUrl(cfg, file), size: utf8Length(serialized) };
}

export async function getGit(location: string): Promise<string> {
  const cfg = getGitConfig();
  const file = decodeURIComponent(location.split('/').pop() || '');
  const raw = await readFileOrThrow(cfg, file, location);
  if (raw === null) throw new Error(`git 仓库中未找到备份文件：${file}`);
  return raw;
}

export async function removeGit(location: string): Promise<void> {
  const cfg = getGitConfig();
  const file = decodeURIComponent(location.split('/').pop() || '');
  if (!file) return;

  try {
    if (cfg.provider === 'gitlab') {
      const url = `${fileApiUrl(cfg, file)}?branch=${encodeURIComponent(cfg.branch)}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: headers(cfg),
        body: JSON.stringify({
          branch: cfg.branch,
          commit_message: `backup(prune): remove ${file}`,
        }),
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`HTTP ${res.status}：${await readError(res)}`);
      }
      return;
    }

    const sha = await fetchSha(cfg, file);
    if (!sha) return;
    const res = await fetch(fileApiUrl(cfg, file), {
      method: 'DELETE',
      headers: headers(cfg),
      body: JSON.stringify({
        message: `backup(prune): remove ${file}`,
        sha,
        branch: cfg.branch,
      }),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`HTTP ${res.status}：${await readError(res)}`);
    }
  } catch {
    // 与其他目标一致：删除失败不阻断备份流程（可能是 404 / 权限不足）
  }
}

/** 读取指定 location 的内容；location 与当前配置不一致时直接用 location 请求 */
async function readFileOrThrow(
  cfg: GitConfig,
  file: string,
  location: string
): Promise<string | null> {
  const current = fileApiUrl(cfg, file);
  if (current === location) return fetchRaw(cfg, file);

  // 备份记录写于旧配置下：按记录里的 location 读，分支用当前配置
  const separator = location.includes('?') ? '&' : '?';
  const url = `${location}${separator}ref=${encodeURIComponent(cfg.branch)}`;
  const res = await fetch(url, { headers: headers(cfg) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`读取失败 (HTTP ${res.status})：${await readError(res)}`);
  const data = (await res.json()) as { content?: string; encoding?: string };
  if (typeof data.content !== 'string') throw new Error('无法解析仓库返回的文件内容');
  return data.encoding === 'base64' ? fromBase64(data.content) : data.content;
}

/** 连通性测试：读取仓库信息（能过即说明 token 与仓库名有效） */
export async function testGit(): Promise<{ ok: boolean; detail: string }> {
  const cfg = getGitConfig();
  if (!cfg.repo || !cfg.token) return { ok: false, detail: '未配置 BACKUP_GIT_REPO / BACKUP_GIT_TOKEN' };

  try {
    const res = await fetch(repoApiUrl(cfg), { headers: headers(cfg) });
    if (res.status === 404) {
      return { ok: false, detail: '仓库不存在或无权访问，请检查 BACKUP_GIT_REPO 与 Token 权限' };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: `鉴权失败 (HTTP ${res.status})，请检查 BACKUP_GIT_TOKEN` };
    }
    if (!res.ok) {
      return { ok: false, detail: `访问异常 (HTTP ${res.status})：${await readError(res)}` };
    }

    const info = (await res.json()) as { default_branch?: string; path?: string; web_url?: string };
    const branch = cfg.branch || info.default_branch || 'main';
    return {
      ok: true,
      detail: `连接成功（${cfg.provider} · ${info.path ?? cfg.repo} · 分支 ${branch}）`,
    };
  } catch (err) {
    return { ok: false, detail: `连接失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

export const gitTarget: BackupTarget = 'git';