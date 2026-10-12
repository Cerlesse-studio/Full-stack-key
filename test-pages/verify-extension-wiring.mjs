/**
 * 静态校验扩展的接线：manifest 里列的文件是否存在、扫码页引用的元素 id 与
 * 脚本里 getElementById 的 id 是否对得上、共用模块是否在需要的地方都引入了。
 *
 *   node test-pages/verify-extension-wiring.mjs
 */
import { readFileSync, existsSync } from 'node:fs';

let failed = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log(`✓ ${label}`);
  else {
    failed += 1;
    console.error(`✗ ${label}${extra ? ` — ${extra}` : ''}`);
  }
};

const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));

// 1. manifest 里点名的文件都得在
const declared = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
  ...manifest.content_scripts.flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]),
  ...Object.values(manifest.icons),
];
for (const file of declared) {
  ok(existsSync(`extension/${file}`), `manifest 引用的文件存在：${file}`);
}

// 2. 解码器与取景框模块必须在内容脚本里排在 content.js 前面
const contentScriptJs = manifest.content_scripts[0].js;
ok(
  contentScriptJs.indexOf('vendor/jsQR.min.js') < contentScriptJs.indexOf('content.js') &&
    contentScriptJs.indexOf('qr-capture.js') < contentScriptJs.indexOf('content.js'),
  'jsQR 与取景框模块在 content.js 之前加载',
  contentScriptJs.join(', ')
);
ok(
  manifest.content_scripts[0].css.includes('qr-capture.css'),
  '取景框样式随内容脚本注入（绕开宿主页面 CSP）'
);

// 3. host_permissions 必须有，否则 captureVisibleTab 会直接被拒
ok(manifest.host_permissions.includes('<all_urls>'), 'host_permissions 含 <all_urls>（截屏权限）');

// 4. 扫码页引用的每个 id 都得在 HTML 里
const scannerHtml = readFileSync('extension/scanner.html', 'utf8');
const scannerJs = readFileSync('extension/scanner.js', 'utf8');
const htmlIds = new Set([...scannerHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const jsIds = new Set([...scannerJs.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]));
for (const id of jsIds) ok(htmlIds.has(id), `scanner.js 需要的 #${id} 在页面里`);
for (const id of htmlIds) ok(jsIds.has(id) || id === 'mode-hint', `页面里的 #${id} 有脚本在用`, id);

// 5. 脚本与样式按正确顺序引入
const scriptOrder = [...scannerHtml.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
ok(
  scriptOrder.indexOf('vendor/jsQR.min.js') < scriptOrder.indexOf('qr-capture.js') &&
    scriptOrder.indexOf('qr-capture.js') < scriptOrder.indexOf('scanner.js'),
  '扫码页脚本顺序：jsQR → 取景框 → 扫码页逻辑',
  scriptOrder.join(', ')
);
ok(scannerHtml.includes('qr-capture.css'), '扫码页引入了共用的取景框样式');

// 6. 已经不用的摄像头代码要清干净
ok(!/getUserMedia|mediaDevices|<video/.test(scannerJs), 'scanner.js 里没有摄像头代码');
ok(!/<video/.test(scannerHtml), 'scanner.html 里没有 video 元素');
ok(!/getUserMedia|mediaDevices/.test(readFileSync('extension/content.js', 'utf8')), 'content.js 里没有摄像头代码');

// 7. 共用模块要挂在 globalThis 上，两个宿主才都拿得到
const captureSrc = readFileSync('extension/qr-capture.js', 'utf8');
ok(
  /\(typeof globalThis !== 'undefined' \? globalThis : window\)/.test(captureSrc),
  'qr-capture.js 在两种宿主下都取到同一个全局对象'
);
ok(/typeof global\.jsQR === 'function'/.test(captureSrc), '取景框模块用的是 vendor 包挂出的 global.jsQR');
ok(/global\.KeyVaultQrCapture = \{/.test(captureSrc), 'qr-capture.js 导出 KeyVaultQrCapture');
for (const key of ['open: open', 'decodeDataUrl: decodeDataUrl', 'decodeBlob: decodeBlob', 'hasDecoder:']) {
  ok(captureSrc.includes(key), `导出 ${key.replace(/:.*/, '')}`);
}

// 8. 三个入口的文案都别再宣称用摄像头（“不用摄像头”这类说法不算）
for (const file of ['extension/popup.html', 'extension/popup.js', 'extension/options.html', 'extension/options.js']) {
  const src = readFileSync(file, 'utf8');
  const claimsCamera = src
    .split('\n')
    .filter((line) => line.includes('摄像头') && !/不用摄像头|无需摄像头|不需要摄像头/.test(line));
  ok(claimsCamera.length === 0, `${file} 里不再提摄像头`, claimsCamera.join(' / '));
}

// 9. 旧的悬浮徽章样式要彻底没了
const contentCss = readFileSync('extension/content.css', 'utf8');
ok(!contentCss.includes('keyvault-input-badge'), 'content.css 里没有旧徽章样式');
const contentJs = readFileSync('extension/content.js', 'utf8');
ok(!/keyvault-input-badge/.test(contentJs), 'content.js 里没有旧徽章标记');

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);