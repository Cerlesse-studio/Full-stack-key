import type { NextRequest } from 'next/server';
import { getSessionAuthContext } from '@/lib/auth/context';
import { handleRouteError } from '@/lib/errors';
import { renderQrSvg, type QrErrorCorrection } from '@/lib/qrcode';

export const dynamic = 'force-dynamic';

const ECC_LEVELS = new Set<QrErrorCorrection>(['L', 'M', 'Q', 'H']);

/**
 * GET /api/qrcode?data=<文本>&size=&margin=&ecc=&dark=&light=
 *
 * 返回 SVG 二维码。要求已登录：接口本身不限内容，
 * 不鉴权就等于开了一个给人白嫖算力的渲染端点。
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await getSessionAuthContext();
    if (!auth) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    const { searchParams } = new URL(request.url);
    const sizeParam = searchParams.get('size');
    const marginParam = searchParams.get('margin');
    const eccParam = searchParams.get('ecc');

    const svg = await renderQrSvg(searchParams.get('data') ?? '', {
      size: sizeParam === null ? undefined : Number(sizeParam),
      margin: marginParam === null ? undefined : Number(marginParam),
      errorCorrectionLevel:
        eccParam && ECC_LEVELS.has(eccParam.toUpperCase() as QrErrorCorrection)
          ? (eccParam.toUpperCase() as QrErrorCorrection)
          : 'Q',
      dark: searchParams.get('dark') ?? undefined,
      light: searchParams.get('light') ?? undefined,
    });

    return new Response(svg, {
      status: 200,
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        // 内容每次都可能不同（含一次性配对码），不缓存
        'Cache-Control': 'no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
