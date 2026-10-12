import type { NextRequest } from 'next/server';
import { handleRouteError } from '@/lib/errors';
import { jsonSuccess } from '@/lib/utils/response';
import { maybeRunScheduledBackup } from '@/lib/backup';

export const dynamic = 'force-dynamic';

/**
 * 无人值守备份入口（Cloudflare Cron / 外部调度器）。
 * 需要请求头 `Authorization: Bearer <CRON_TOKEN>`，并配置环境变量 BACKUP_PASSPHRASE。
 *
 * GET 与 POST 行为一致：Cloudflare Cron 触发器固定发 GET，
 * 外部调度器（cron 面板、curl、GitHub Actions）更常用 POST。
 * 形如：curl https://<domain>/api/backups/cron -H "Authorization: Bearer $CRON_TOKEN"
 */
async function handleScheduledBackup(request: NextRequest) {
  try {
    const expected = process.env.CRON_TOKEN;
    if (!expected) {
      return Response.json(
        { success: false, error: { code: 'CRON_NOT_CONFIGURED', message: '服务端未配置 CRON_TOKEN' } },
        { status: 503 }
      );
    }

    const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (provided !== expected) {
      return Response.json(
        { success: false, error: { code: 'UNAUTHORIZED', message: 'CRON_TOKEN 不匹配' } },
        { status: 401 }
      );
    }

    if (!process.env.BACKUP_PASSPHRASE) {
      return Response.json(
        {
          success: false,
          error: { code: 'BACKUP_PASSPHRASE_REQUIRED', message: '无人值守备份需配置 BACKUP_PASSPHRASE' },
        },
        { status: 503 }
      );
    }

    const { searchParams } = new URL(request.url);
    const ownerId = searchParams.get('ownerId') || 'user_default';
    const force = searchParams.get('force') === 'true';

    const outcome = await maybeRunScheduledBackup(
      { ownerId, passphrase: process.env.BACKUP_PASSPHRASE },
      { force }
    );

    return jsonSuccess(outcome);
  } catch (err) {
    return handleRouteError(err);
  }
}

export const GET = handleScheduledBackup;
export const POST = handleScheduledBackup;
