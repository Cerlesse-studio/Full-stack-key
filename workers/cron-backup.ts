/**
 * 无人值守备份的 Cloudflare Cron Worker。
 *
 * 与主应用分开部署，避免影响 OpenNext 的构建产物：
 *   1) 修改 wrangler.cron.toml 中的 APP_URL 为你的应用域名
 *   2) npx wrangler secret put CRON_TOKEN --config wrangler.cron.toml
 *      （该值必须与主应用环境变量 CRON_TOKEN 一致）
 *   3) npx wrangler deploy --config wrangler.cron.toml
 *
 * 主应用侧还需配置 BACKUP_PASSPHRASE，Cron 场景没有会话主密钥可用。
 */

// 声明最小必要的类型，避免额外引入 @cloudflare/workers-types
interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  APP_URL: string;
  CRON_TOKEN: string;
  /** 可选：指定要备份的 ownerId，默认 user_default */
  OWNER_ID?: string;
  /** 可选：true 时忽略备份间隔，每次 Cron 都执行 */
  FORCE?: string;
}

const cronWorker = {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const task = runBackup(env, event).catch((err) => {
      console.error('[backup-cron] 执行失败:', err instanceof Error ? err.message : String(err));
    });
    ctx.waitUntil(task);
  },
};

export default cronWorker;

async function runBackup(env: Env, event: ScheduledEvent): Promise<void> {
  if (!env.APP_URL) throw new Error('缺少 APP_URL');
  if (!env.CRON_TOKEN) throw new Error('缺少 CRON_TOKEN');

  const url = new URL('/api/backups/cron', env.APP_URL);
  if (env.OWNER_ID) url.searchParams.set('ownerId', env.OWNER_ID);
  if (env.FORCE === 'true') url.searchParams.set('force', 'true');

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CRON_TOKEN}` },
  });

  const text = await res.text();
  console.log(
    `[backup-cron] cron=${event.cron} status=${res.status} body=${text.slice(0, 300)}`
  );

  if (!res.ok) {
    throw new Error(`备份接口返回 HTTP ${res.status}`);
  }
}
