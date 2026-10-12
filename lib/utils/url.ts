/**
 * 解析保险库对外可访问的基础地址（不含结尾斜杠）。
 *
 * 扫码配对时二维码里必须放一个手机真的能打开的地址。反代 / Cloudflare 后面
 * request.url 的 origin 经常是内网地址，所以优先用显式配置的 VAULT_PUBLIC_URL。
 */
export function resolveVaultBaseUrl(request: Request): string {
  const configured = process.env.VAULT_PUBLIC_URL?.trim();
  if (configured) {
    return stripTrailingSlash(configured);
  }

  try {
    const url = new URL(request.url);
    return stripTrailingSlash(url.origin);
  } catch {
    return '';
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
