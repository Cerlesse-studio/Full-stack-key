'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, QrCode, RefreshCw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils/cn';

interface PairingInfo {
  token: string;
  expiresAt: string;
  payloadUrl: string;
  qrUrl: string;
}

function secondsLeft(expiresAt: string): number {
  return Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000));
}

/**
 * 「扫码连接」卡片。
 *
 * 二维码里只有服务器地址 + 一个 60 秒有效、用后作废的配对码，
 * 不含主密码。客户端扫码后拿配对码换一把只属于本保险库的 API Key，
 * 于是不用再手打服务器地址，剩下的只需要输入主密码。
 */
export function QrPairingCard() {
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const generate = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/pairing', { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) {
        throw new Error(body?.error?.message || '生成配对码失败');
      }
      setPairing(body.data as PairingInfo);
      setRemaining(secondsLeft(body.data.expiresAt));
    } catch (err) {
      setPairing(null);
      toast.error(err instanceof Error ? err.message : '生成配对码失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // 倒数；归零后立刻把二维码撤掉，避免屏幕一直挂着一个扫不开的码
  useEffect(() => {
    if (!pairing) return;

    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      const left = secondsLeft(pairing.expiresAt);
      setRemaining(left);
      if (left === 0) {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
        setPairing(null);
        toast.info('配对码已过期，需要重新生成');
      }
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [pairing]);

  const expired = pairing !== null && remaining === 0;

  return (
    <div className="space-y-4 rounded-xl border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">扫码连接</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            用手机相机扫下面的二维码，客户端会自动填好服务器地址与 API 密钥，
            不用再手动输入。
          </p>
        </div>
        <Button type="button" onClick={generate} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : expired ? <RefreshCw /> : <QrCode />}
          {loading ? '生成中...' : pairing ? '重新生成' : '生成二维码'}
        </Button>
      </div>

      {pairing && !expired && (
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          <div className="shrink-0 rounded-xl border bg-white p-3">
            {/* 同源动态接口地址，next/image 无法优化，直接用原生 img */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={pairing.qrUrl}
              alt="扫码连接二维码"
              width={224}
              height={224}
              className="size-56"
            />
          </div>

          <div className="min-w-0 flex-1 space-y-3">
            <div
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium',
                remaining <= 15
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              )}
            >
              <span className="size-1.5 rounded-full bg-current" />
              {remaining} 秒后失效 · 核销一次即作废
            </div>

            <div className="space-y-1.5">
              <div className="text-xs text-muted-foreground">扫码后打开的地址</div>
              <div className="flex w-full items-center gap-2 rounded-lg border bg-background p-3 font-mono text-sm break-all">
                <span className="min-w-0 flex-1">{pairing.payloadUrl}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    navigator.clipboard.writeText(pairing.payloadUrl);
                    toast.success('已复制到剪贴板');
                  }}
                >
                  复制
                </Button>
              </div>
            </div>

            <Alert>
              <ShieldCheck />
              <AlertTitle>二维码里没有主密码</AlertTitle>
              <AlertDescription>
                只有服务器地址和一个 60 秒有效的配对码。
                旁边有人拍照也只能在 60 秒内、且只能换到一把 API 密钥，
                解密仍然需要主密码。要彻底撤销，去「API 密钥」页吊销对应的密钥即可。
              </AlertDescription>
            </Alert>
          </div>
        </div>
      )}

      {!pairing && !loading && (
        <p className="text-sm text-muted-foreground">
          还没有生成配对码。点击右上角按钮，二维码有效期 60 秒。
        </p>
      )}
    </div>
  );
}
