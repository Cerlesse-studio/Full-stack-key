import type { NextRequest } from 'next/server';
import { getSessionAuthContext } from '@/lib/auth/context';
import { AuthenticationError } from '@/lib/errors';
import { handleRouteError } from '@/lib/errors';
import { jsonSuccess } from '@/lib/utils/response';
import { resolveVaultBaseUrl } from '@/lib/utils/url';
import {
  createPairingToken,
} from '@/lib/repositories/pairingRepository';

export const dynamic = 'force-dynamic';

/**
 * POST /api/pairing
 *
 * 生成一次性配对码。仅允许已登录的管理员会话调用 ——
 * 拿 API Key 来换 API Key 会变成凭证自我复制，防线就没了。
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getSessionAuthContext();
    if (!auth) {
      throw new AuthenticationError('请先登录后再生成配对码');
    }

    const record = await createPairingToken(auth.ownerId);
    const baseUrl = resolveVaultBaseUrl(request);
    const payloadUrl = `${baseUrl}/?pair=${record.token}`;
    const qrUrl = `/api/qrcode?size=320&margin=2&ecc=Q&data=${encodeURIComponent(payloadUrl)}`;

    return jsonSuccess({
      token: record.token,
      ownerId: record.ownerId,
      expiresAt: record.expiresAt,
      ttlSeconds: Math.max(
        0,
        Math.round((Date.parse(record.expiresAt) - Date.now()) / 1000)
      ),
      /** 扫码后打开的地址 */
      payloadUrl,
      /** 直接放进 <img src> 的二维码地址 */
      qrUrl,
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
