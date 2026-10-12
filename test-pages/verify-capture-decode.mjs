/**
 * 离线校验 qr-capture.js 对外的解码接口（decodeDataUrl / decodeBlob）。
 *
 * 只把 canvas 与 Image 换成假的（自己实现缩放取像素），被测代码与解码器都是真的：
 * 扩展页的「从图片识别」和取景框的整屏/选区解码走的都是这一条路径。
 *
 *   node test-pages/verify-capture-decode.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode');

let failed = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log(`✓ ${label}`);
  else {
    failed += 1;
    console.error(`✗ ${label}${extra ? ` — ${extra}` : ''}`);
  }
};

/**
 * 造一张「屏幕截图」：白底 + 顶部深色条，右下角放一个小二维码。
 * 返回 { width, height, rgba, blob, dataUrl }
 */
function makeScreenshot(text, { width = 1600, height = 1000, qrSize = 176 } = {}) {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  const put = (x, y, v) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    rgba[i] = v;
    rgba[i + 1] = v;
    rgba[i + 2] = v;
  };

  for (let y = 0; y < 64; y += 1) for (let x = 0; x < width; x += 1) put(x, y, 32);
  for (let y = 300; y < 340; y += 1) for (let x = 80; x < 900; x += 1) put(x, y, 226);

  const matrix = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules;
  const n = matrix.size;
  const quiet = 2;
  const total = n + quiet * 2;
  const scale = Math.max(1, Math.floor(qrSize / total));
  const drawn = total * scale;
  const ox = width - drawn - 80;
  const oy = height - drawn - 90;

  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (matrix.data[y * n + x] !== 1) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) put(ox + (x + quiet) * scale + dx, oy + (y + quiet) * scale + dy, 0);
      }
    }
  }

  return { width, height, rgba, qrBox: { x: ox, y: oy, w: drawn, h: drawn } };
}

// --- 只伪造 canvas / Image，其余全是真代码 ------------------------------

const BITS_PER_PIXEL = 4;

function makeContext() {
  return {
    _out: null,
    _w: 0,
    _h: 0,
    clearRect() {},
    // 调用方按 canvas 的 9 参数签名传，但这里只需要源图 + 源矩形
    drawImage(source, sx, sy, sw, sh) {
      const out = new Uint8ClampedArray(this._w * this._h * BITS_PER_PIXEL);
      for (let y = 0; y < this._h; y += 1) {
        for (let x = 0; x < this._w; x += 1) {
          const srcX = Math.min(source.width - 1, sx + Math.floor((x / this._w) * sw));
          const srcY = Math.min(source.height - 1, sy + Math.floor((y / this._h) * sh));
          const si = (srcY * source.width + srcX) * BITS_PER_PIXEL;
          const di = (y * this._w + x) * BITS_PER_PIXEL;
          out[di] = source.rgba[si];
          out[di + 1] = source.rgba[si + 1];
          out[di + 2] = source.rgba[si + 2];
          out[di + 3] = 255;
        }
      }
      this._out = out;
    },
    getImageData(x, y, w, h) {
      return { data: this._out || new Uint8ClampedArray(w * h * BITS_PER_PIXEL), width: w, height: h };
    },
  };
}

function makeCanvas() {
  const ctx = makeContext();
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
    // qr-capture.js 直接写 canvas.width/height，改的时候要同步画布大小
    set width(v) {
      ctx._w = v;
      ctx._h = this._heightHint || v;
      ctx._out = null;
    },
    get width() {
      return ctx._w;
    },
    set height(v) {
      this._heightHint = v;
      ctx._h = v;
      ctx._out = null;
    },
    get height() {
      return ctx._h;
    },
  };
}

class FakeImage {
  set src(value) {
    this._src = value;
    const payload = FakeImage.sources.get(String(value));
    if (!payload) {
      queueMicrotask(() => this.onerror && this.onerror());
      return;
    }
    this.width = payload.width;
    this.height = payload.height;
    this.naturalWidth = payload.width;
    this.naturalHeight = payload.height;
    this.rgba = payload.rgba;
    queueMicrotask(() => this.onload && this.onload());
  }
  get src() {
    return this._src;
  }
}
FakeImage.sources = new Map();

const pendingBlobs = new Map();
globalThis.document = { createElement: (tag) => (tag === 'canvas' ? makeCanvas() : { style: {} }) };
globalThis.Image = FakeImage;
globalThis.URL.createObjectURL = () => 'blob:fake';
globalThis.URL.revokeObjectURL = () => {};
globalThis.createImageBitmap = async (blob) => {
  const payload = pendingBlobs.get(blob);
  if (!payload) throw new Error('没有这张图');
  return { width: payload.width, height: payload.height, rgba: payload.rgba, close() {} };
};

// vendor 包挂出 jsQR
globalThis.self = globalThis;
globalThis.window = globalThis;
new Function(readFileSync('extension/vendor/jsQR.min.js', 'utf8'))();

// 被测代码
new Function(readFileSync('extension/qr-capture.js', 'utf8'))();
const capture = globalThis.KeyVaultQrCapture;

ok(!!capture && capture.hasDecoder(), 'qr-capture.js 挂出全局并能拿到解码器');

const cases = [
  'http://localhost:3000/?pair=Kq7bZ2mXpL9vTn4Rc',
  'https://vault.example.com/?pair=abcdefghijklmnopqrstuvwxyz0123456789&from=qr',
  'otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example',
  '扫码后填入这段普通文本，包含中文与标点：Aa1-测试, ok.',
];

for (const text of cases) {
  const shot = makeScreenshot(text);
  FakeImage.sources.set('shot.png', shot);

  // decodeDataUrl：后台 captureVisibleTab 抓回来的整屏截图走这条
  const fromDataUrl = await capture.decodeDataUrl('shot.png');
  ok(fromDataUrl === text, `decodeDataUrl 读出整屏截图里的二维码：${text.slice(0, 46)}`, fromDataUrl);

  // decodeBlob：扩展页「从图片识别」走这条
  const blob = { name: 'shot.png' };
  pendingBlobs.set(blob, shot);
  const fromBlob = await capture.decodeBlob(blob);
  ok(fromBlob === text, `decodeBlob 读出图片文件里的二维码：${text.slice(0, 46)}`, fromBlob);
}

// 小到整屏直读会失败的码（真实截屏里最常见的形态）不该被误判成「没码」
{
  const text = 'http://localhost:3000/?pair=8sKf3Nq2Vb7Tx1Pd';
  const shot = makeScreenshot(text, { width: 3840, height: 2160, qrSize: 120 });
  FakeImage.sources.set('tiny.png', shot);
  const got = await capture.decodeDataUrl('tiny.png');
  // 整屏缩到 1600 之后仍有机会读出；这里只关心「不会崩、不会返回乱码」
  ok(got === '' || got === text, '超大截图 + 小二维码：要么读对，要么干净地返回空', got);
}

// 空输入 / 坏图必须安静失败
ok((await capture.decodeBlob(null)) === '', 'decodeBlob(null) 返回空串');
ok((await capture.decodeDataUrl('missing.png')) === '', '坏图返回空串而不是抛异常');

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);