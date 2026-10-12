/**
 * 读取二维码（扩展页）
 *
 * 主流程是「截屏」而不是开摄像头：二维码本来就显示在屏幕上（保险库设置页的
 * 扫码配对卡片等），打开摄像头对着自己的显示器纯属折腾。后台用
 * chrome.tabs.captureVisibleTab 抓一张标签页可见区域的图，这里再叠一层取景框
 * 让用户框住要读的码，解码器是 vendor 进来的 jsQR（桌面版 Chrome 从未实现
 * 原生 BarcodeDetector）。
 *
 * 识别到的东西分两类：
 *  - 保险库配对链接（<base>/?pair=<token>）→ 交给后台换成 API Key 写进扩展配置；
 *  - 其它文本 → 写回 chrome.storage，由发起扫码的网页填进对应输入框。
 */
(function () {
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') === 'pair' ? 'pair' : 'fill';

  /** 扫码页与页面之间的中转键，必须和 content.js 里的保持一致 */
  const SCAN_RESULT_KEY = 'keyvaultScanResult';
  /** 扫出来的文本长度上限，防止拿一张超大图把内存和存储写爆 */
  const MAX_TEXT_LENGTH = 4096;

  const capture = window.KeyVaultQrCapture;
  const statusEl = document.getElementById('status');
  const modeHint = document.getElementById('mode-hint');
  const btnCapture = document.getElementById('btn-capture');
  const btnPick = document.getElementById('btn-pick');
  const btnManual = document.getElementById('btn-manual');
  const manualRow = document.getElementById('manual-row');
  const manualText = document.getElementById('manual-text');
  const btnManualSubmit = document.getElementById('btn-manual-submit');
  const fileInput = document.getElementById('file-input');

  let settled = false;
  let overlay = null;

  if (mode === 'pair') {
    modeHint.textContent = '截取电脑端「设置 → API 密钥 → 扫码连接」里的二维码，识别后自动完成配对';
  }

  if (!capture || !capture.hasDecoder()) {
    btnCapture.disabled = true;
    btnPick.disabled = true;
    setStatus('二维码解码器缺失（vendor/jsQR.min.js 没有加载成功），请改用「手动输入」', 'err');
  }

  // --- 截屏 --------------------------------------------------------------

  async function requestCapture() {
    const res = await chrome.runtime.sendMessage({ type: 'CAPTURE_ACTIVE_TAB' }).catch(() => null);
    if (!res || res.ok !== true) {
      throw new Error((res && res.error) || '截屏失败');
    }
    return res.dataUrl;
  }

  btnCapture.addEventListener('click', () => {
    if (settled) return;
    closeOverlay();
    setStatus('正在截取屏幕…');

    requestCapture()
      .then((dataUrl) => openOverlay(dataUrl))
      .catch((err) => setStatus(err.message || '截屏失败', 'err'));
  });

  function openOverlay(dataUrl) {
    setStatus('');
    overlay = capture.open({
      document,
      mount: document.body,
      dataUrl,
      hint: '拖动鼠标框住屏幕上的二维码，松手后自动识别',
      // 截的是另一个标签页，所以这里不用先把取景框藏起来
      recapture: requestCapture,
      onDecoded: (text) => {
        closeOverlay();
        handleText(text);
      },
      onCancel: () => setStatus('已取消'),
      onError: (message) => setStatus(message || '无法显示取景框', 'err'),
    });
  }

  function closeOverlay() {
    if (overlay) {
      overlay.close();
      overlay = null;
    }
  }

  // --- 从图片识别 --------------------------------------------------------

  btnPick.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file || settled) return;

    closeOverlay();
    setStatus('正在识别图片…');

    try {
      const text = await capture.decodeBlob(file);
      if (text) {
        handleText(text);
      } else {
        setStatus('这张图片里没有识别到二维码', 'err');
      }
    } catch {
      setStatus('图片读取失败，请换一张试试', 'err');
    }
  });

  // --- 手动输入 ----------------------------------------------------------

  btnManual.addEventListener('click', () => {
    manualRow.hidden = !manualRow.hidden;
    if (!manualRow.hidden) manualText.focus();
  });

  const submitManual = () => handleText(manualText.value);
  btnManualSubmit.addEventListener('click', submitManual);
  manualText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitManual();
    }
  });

  // --- 结果处理 ----------------------------------------------------------

  async function handleText(raw) {
    const text = String(raw || '').trim().slice(0, MAX_TEXT_LENGTH);
    if (!text || settled) return;

    settled = true;

    const parsed = parsePairPayload(text);
    if (parsed) {
      await redeemPairing(parsed);
      return;
    }

    if (mode === 'fill') {
      try {
        await chrome.storage.local.set({
          [SCAN_RESULT_KEY]: { text, at: Date.now() },
        });
        setStatus('已回填到网页输入框，正在关闭…', 'ok');
      } catch (err) {
        settled = false;
        setStatus('回填失败：' + ((err && err.message) || '未知错误'), 'err');
        return;
      }
    } else {
      // 从配置弹窗进来的没法回填网页，退一步让用户自己复制
      try {
        await navigator.clipboard.writeText(text);
        setStatus('已复制到剪贴板', 'ok');
      } catch {
        setStatus('内容：' + text);
      }
    }

    setTimeout(() => window.close(), 900);
  }

  /** 与 popup.js / content.js 的同名函数保持一致：完整配对链接或裸配对码 */
  function parsePairPayload(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;

    if (/^https?:\/\//i.test(text)) {
      let url;
      try {
        url = new URL(text);
      } catch {
        return null;
      }
      const token = url.searchParams.get('pair');
      return token ? { baseUrl: url.origin, token } : null;
    }

    return /^[A-Za-z0-9_-]{16,128}$/.test(text) ? { baseUrl: null, token: text } : null;
  }

  /**
   * 换密钥这件事只有后台能做（只有它能写配置、广播 PAIR_CONNECTED），
   * 所以这里不再自己发请求。裸配对码不带地址时留空，后台会退回用扩展里
   * 已配置的服务地址（发起扫码的网页地址跟保险库无关，不能拿来当默认）。
   */
  async function redeemPairing(parsed) {
    setStatus('识别到配对码，正在连接保险库…');

    const res = await chrome.runtime
      .sendMessage({
        type: 'REDEEM_PAIR_TOKEN',
        payload: { token: parsed.token, baseUrl: parsed.baseUrl || '' },
      })
      .catch(() => null);

    if (!res || res.ok !== true) {
      settled = false;
      setStatus((res && res.error) || '配对失败，请回电脑端重新生成二维码', 'err');
      return;
    }

    setStatus('配对成功，扩展已连接到保险库，正在关闭…', 'ok');
    setTimeout(() => window.close(), 1100);
  }

  function setStatus(message, kind) {
    statusEl.textContent = message || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }
})();