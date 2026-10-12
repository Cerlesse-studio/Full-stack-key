/**
 * 离线校验 vendor 进来的 jsQR 能否正确解码。
 * 不经过浏览器：用 qrcode 生成真实二维码矩阵，手工拼成 RGBA 位图丢给解码器。
 *
 *   node test-pages/verify-jsqr.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode');

// 模拟扩展页里的加载环境：UMD 包在浏览器里挂到 window.jsQR
globalThis.self = globalThis;
globalThis.window = globalThis;
new Function(readFileSync('extension/vendor/jsQR.min.js', 'utf8'))();

if (typeof globalThis.jsQR !== 'function') {
  console.error('✗ vendor 包没有挂出全局 jsQR，scanner.js 会直接降级到手动输入');
  process.exit(1);
}
console.log('✓ vendor 包已挂出 window.jsQR');

const SCALE = 4;
const QUIET = 4;

/**
 * 把 qrcode 的模块矩阵渲染成 jsQR 需要的 RGBA 位图。
 * 直接读 matrix.data 而不用 matrix.get()：负下标会绕回到数组头部，
 * 静默串进二维码图案里。
 */
function toImageData(matrix) {
  const n = matrix.size;
  const size = n + QUIET * 2;
  const width = size * SCALE;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);

  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (matrix.data[y * n + x] !== 1) continue;
      for (let dy = 0; dy < SCALE; dy += 1) {
        for (let dx = 0; dx < SCALE; dx += 1) {
          const i = (((y + QUIET) * SCALE + dy) * width + (x + QUIET) * SCALE + dx) * 4;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
        }
      }
    }
  }

  return { data, width, height: width };
}

const cases = [
  'http://localhost:3000/?pair=Kq7bZ2mXpL9vTn4Rc',
  'Kq7bZ2mXpL9vTn4Rc',
  'otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example',
  '扫码后填入这段普通文本，包含中文与标点：Aa1-测试, ok.',
  'https://vault.example.com/?pair=abcdefghijklmnopqrstuvwxyz0123456789&from=qr',
];

let failed = 0;
for (const text of cases) {
  const matrix = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules;
  const image = toImageData(matrix);
  const result = globalThis.jsQR(image.data, image.width, image.height, {
    inversionAttempts: 'attemptBoth',
  });

  if (result && result.data === text) {
    console.log(`✓ ${text.slice(0, 52)}`);
  } else {
    failed += 1;
    console.error(`✗ 期望 ${text}，实际 ${result ? result.data : 'null'}`);
  }
}

// 反色版本（某些屏幕 / 深色模式下会扫到白底黑码以外的组合）
const inverted = QRCode.create(cases[0], { errorCorrectionLevel: 'M' }).modules;
const img = toImageData(inverted);
for (let i = 0; i < img.data.length; i += 4) {
  img.data[i] = 255 - img.data[i];
  img.data[i + 1] = 255 - img.data[i + 1];
  img.data[i + 2] = 255 - img.data[i + 2];
}
const invertedResult = globalThis.jsQR(img.data, img.width, img.height, {
  inversionAttempts: 'attemptBoth',
});
if (invertedResult && invertedResult.data === cases[0]) {
  console.log('✓ 反色二维码同样可解');
} else {
  failed += 1;
  console.error('✗ 反色二维码解不出来');
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);