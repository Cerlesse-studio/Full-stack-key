/**
 * 测试页静态服务器（零依赖）。
 *
 * 扩展的 host_permissions 是 <all_urls>，但以 file:// 打开的页面需要手动勾选
 * 「允许访问文件网址」才能注入内容脚本。用 http://localhost 提供页面可以避开这个坑。
 *
 *   node test-pages/serve.mjs          # 默认 http://127.0.0.1:4200
 *   node test-pages/serve.mjs 4300     # 指定端口
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.argv[2] || 4200);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') pathname = '/password-test.html';

  // 阻止 ../ 逃逸
  const filePath = join(here, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(here)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found: ' + pathname);
  }
});

server.listen(port, () => {
  console.log(`测试页已启动：http://127.0.0.1:${port}/password-test.html`);
  console.log('按 Ctrl+C 结束');
});