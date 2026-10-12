/**
 * 离线校验「截屏读取二维码」的两条解码路径。
 *
 * 取景框里的流程是：先把整张截图缩到最长边 MAX_FRAME_SIZE 试一次，
 * 失败后把用户框出来的选区（屏幕坐标 → 截图原始像素）再缩到 MAX_CROP_SIZE 解一次。
 * 这里用真实的 qrcode 矩阵拼一张「大截图」，把二维码缩到角落里，
 * 验证这两条路径都能读出来 —— 选区路径尤其要验证坐标换算没错。
 *
 *   node test-pages/verify-screen-scan.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode');

globalThis.self = globalThis;
globalThis.window = globalThis;
new Function(readFileSync('extension/vendor/jsQR.min.js', 'utf8'))();

// 与 extension/qr-capture.js 保持一致
const MAX_FRAME_SIZE = 1600;
const MAX_CROP_SIZE = 1000;

if (typeof globalThis.jsQR !== 'function') {
  console.error('✗ vendor 包没有挂出全局 jsQR');
  process.exit(1);
}

const SCREEN_W = 2560;
const SCREEN_H = 1440;
const QR_SIZE = 176;

/** 造一张「大截图」：白底 + 左上角一块杂色，角落里放一个小二维码 */
function makeScreenshot(text) {
  const data = new Uint8ClampedArray(SCREEN_W * SCREEN_H * 4).fill(255);

  const put = (x, y, v) => {
    if (x < 0 || y < 0 || x >= SCREEN_W || y >= SCREEN_H) return;
    const i = (y * SCREEN_W + x) * 4;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  };

  // 顶部一条深色标题栏，模拟真实页面，别让整张图白得没有层次
  for (let y = 0; y < 96; y += 1) {
    for (let x = 0; x < SCREEN_W; x += 1) put(x, y, 32);
  }

  const matrix = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules;
  const n = matrix.size;
  const quiet = 2;
  const total = n + quiet * 2;
  const scale = Math.max(1, Math.floor(QR_SIZE / total));
  const drawn = total * scale;

  // 摆在页面右下角
  const originX = SCREEN_W - drawn - 120;
  const originY = SCREEN_H - drawn - 160;

  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (matrix.data[y * n + x] !== 1) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          put(originX + (x + quiet) * scale + dx, originY + (y + quiet) * scale + dy, 0);
        }
      }
    }
  }

  return { data, originX, originY, drawn };
}

/** 与取景框一致：把源图某个矩形缩放后交给 jsQR */
function decodeRect(data, sw, sx, sy, cw, ch, maxSize) {
  const scale = Math.min(1, maxSize / Math.max(cw, ch));
  const w = Math.max(1, Math.round(cw * scale));
  const h = Math.max(1, Math.round(ch * scale));
  const out = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const srcX = Math.min(sw - 1, sx + Math.round(x / scale));
      const srcY = sy + Math.round(y / scale);
      const si = (srcY * sw + srcX) * 4;
      const di = (y * w + x) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = 255;
    }
  }

  const result = globalThis.jsQR(out, w, h, { inversionAttempts: 'attemptBoth' });
  return result ? result.data : '';
}

const cases = [
  'http://localhost:3000/?pair=Kq7bZ2mXpL9vTn4Rc',
  'https://vault.example.com/?pair=abcdefghijklmnopqrstuvwxyz0123456789&from=qr',
  'otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example',
];

let failed = 0;
for (const text of cases) {
  const shot = makeScreenshot(text);

  const full = decodeRect(shot.data, SCREEN_W, 0, 0, SCREEN_W, SCREEN_H, MAX_FRAME_SIZE);
  console.log(
    `${full === text ? '✓' : '·'} 整屏缩放后直读：${full ? full.slice(0, 48) : '没读到（属正常，会转入选区）'}`
  );

  // 模拟用户框住二维码：屏幕坐标 → 截图原始像素的换算必须精确
  // 取景框里截图是按比例缩放后居中显示的，这里假设它显示成 960x540 放在 (32, 100)
  const rect = { x: 32, y: 100, w: 960, h: 540 };
  const k = SCREEN_W / rect.w;
  const sel = {
    x: rect.x + shot.originX / k - 10,
    y: rect.y + shot.originY / k - 10,
    w: shot.drawn / k + 20,
    h: shot.drawn / k + 20,
  };
  const crop = decodeRect(
    shot.data,
    SCREEN_W,
    Math.round((sel.x - rect.x) * k),
    Math.round((sel.y - rect.y) * k),
    Math.round(sel.w * k),
    Math.round(sel.h * k),
    MAX_CROP_SIZE
  );

  if (crop === text) {
    console.log(`✓ 选区放大后读出：${text.slice(0, 52)}`);
  } else {
    failed += 1;
    console.error(`✗ 选区读取失败：期望 ${text.slice(0, 52)}，实际 ${crop || 'null'}`);
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);