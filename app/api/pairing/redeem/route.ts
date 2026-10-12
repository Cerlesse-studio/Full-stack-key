import type { NextRequest } from 'next/server';
import { createApiKey } from '@/lib/auth/apiKey';
import { handleRouteError } from '@/lib/errors';
import { jsonSuccess } from '@/lib/utils/response';
import { resolveVaultBaseUrl } from '@/lib/utils/url';
import {
  consumePairingToken,
  markPairingAttempt,
} from '@/lib/repositories/pairingRepository';

export const dynamic = 'force-dynamic';

/**
 * POST /api/pairing/redeem  { token }
 *
 * 用一次性配对码换一把只属于当前保险库的 API Key。
 * 这个接口本来就不该要鉴权 —— 调用者此时只有二维码里的那串字符。
 * 配对码 60 秒过期且核销即作废，二维码里也不含主密码。
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const token = typeof body?.token === 'string' ? body.token : '';

    let ownerId: string;
    try {
      const record = await consumePairingToken(token);
      ownerId = record.ownerId;
    } catch (err) {
      // token 被作废或已过期时尝试次数无处可记，忽略即可
      await markPairingAttempt(token).catch(() => undefined);
      throw err;
    }

    const { apiKey } = await createApiKey('扫码配对', ownerId);

    return jsonSuccess({
      apiKey,
      ownerId,
      baseUrl: resolveVaultBaseUrl(request),
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
