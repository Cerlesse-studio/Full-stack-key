/**
 * 伪 chrome API + 伪后台（只在测试页里用）
 *
 * 扩展本身在浏览器里装一下就能测，但 CI / 预览浏览器里装不了。这里把
 * content.js、qr-capture.js 真正跑起来，只把 chrome.* 换成可控的假实现，
 * 这样「截图 → 取景框 → 解码 → 填回输入框」整条链路都能在普通网页里验。
 *
 * 假后台干的事：
 *  - SCREEN_QR_CAPTURE → 生成一张「大截图」（把二维码画到角落，模拟 captureVisibleTab）
 *    再回推给页面，等价于后台 chrome.tabs.sendMessage
 *  - CAPTURE_THIS_TAB / CAPTURE_ACTIVE_TAB → 同一张截图
 *  - REDEEM_PAIR_TOKEN → 记一笔，返回成功
 */
(function () {
  const listeners = [];
  const storageListeners = [];
  const storageData = {};
  const log = [];

  /** 二维码画在截图里的位置，测试脚本要靠它算出取景框里的坐标 */
  const SHOT = { width: 3840, height: 2160, qrSize: 120, qrX: 3300, qrY: 1800 };

  async function buildScreenshot(src) {
    const img = await loadImage(src);
    const canvas = document.createElement('canvas');
    canvas.width = SHOT.width;
    canvas.height = SHOT.height;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#202020';
    ctx.fillRect(0, 0, canvas.width, 120);           // 顶部标题栏
    ctx.fillStyle = '#e4e4e7';
    ctx.fillRect(200, 400, 1200, 60);
    ctx.fillRect(200, 520, 900, 40);
    ctx.drawImage(img, SHOT.qrX, SHOT.qrY, SHOT.qrSize, SHOT.qrSize);
    ctx.fillStyle = '#71717a';
    ctx.font = '28px sans-serif';
    ctx.fillText('scan me', SHOT.qrX, SHOT.qrY - 20);

    return canvas.toDataURL('image/png');
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = src;
    });
  }

  /** 把消息投给页面里注册的 onMessage 监听器，并按 sendResponse 的约定回话 */
  function dispatchToTab(message) {
    return new Promise((resolve) => {
      let settled = false;
      for (const listener of listeners.slice()) {
        if (typeof listener !== 'function') continue;
        const result = listener(message, { id: 'fake' }, (response) => {
          settled = true;
          resolve(response);
        });
        if (result === true) return; // 监听器自己稍后异步回话
        if (result === false && settled) return;
        if (result === undefined && settled) return;
      }
      setTimeout(() => {
        if (!settled) resolve(undefined);
      }, 30);
    });
  }

  async function handle(message) {
    log.push(message);

    switch (message.type) {
      case 'QUERY_CREDENTIALS':
        return { ok: true, items: [], total: 0 };

      case 'GENERATE_PASSWORD':
        return { ok: true, password: 'Aa1!Generated9' };

      case 'SCREEN_QR_CAPTURE': {
        if (window.__failCapture) return { ok: false, error: '模拟的截屏失败：页面不允许截屏' };
        const dataUrl = await buildScreenshot(`/qr-${window.__testQrKind || 'pair'}.png`);
        const sent = await dispatchToTab({ type: 'SCREEN_QR_CAPTURE', dataUrl });
        return sent && sent.ok === true ? { ok: true } : { ok: false, error: '页面没接住截图' };
      }

      case 'CAPTURE_THIS_TAB':
      case 'CAPTURE_ACTIVE_TAB': {
        // 记下截屏那一刻取景框的状态：重新截屏时它必须已经把自己藏起来，
        // 不然会把取景框本身拍进截图
        const overlay = document.querySelector('.keyvault-qr-capture');
        window.__captureProbe = {
          type: message.type,
          overlayPresent: !!overlay,
          visibility: overlay ? getComputedStyle(overlay).visibility : null,
        };
        return { ok: true, dataUrl: await buildScreenshot(`/qr-${window.__testQrKind || 'pair'}.png`) };
      }

      case 'REDEEM_PAIR_TOKEN':
        return { ok: true, apiUrl: message.payload.baseUrl || 'http://localhost:3000' };

      default:
        return { ok: false, error: `未知消息类型: ${message.type}` };
    }
  }

  window.chrome = {
    runtime: {
      id: 'fake-extension',
      sendMessage: (message) => Promise.resolve(handle(message)),
      onMessage: {
        addListener: (fn) => listeners.push(fn),
      },
      getURL: (path) => new URL(path, location.href).toString(),
      sendNativeMessage: () => Promise.resolve(),
    },
    storage: {
      local: {
        get: (keys) => Promise.resolve(pick(storageData, keys)),
        set: (items) => {
          // 真实 API 回调的是 { oldValue, newValue }，别直接传新值
          const changes = {};
          for (const key of Object.keys(items)) {
            changes[key] = { oldValue: storageData[key], newValue: items[key] };
          }
          Object.assign(storageData, items);
          fireStorageChange(changes);
          return Promise.resolve();
        },
        remove: (key) => {
          const changes = { [key]: { oldValue: storageData[key], newValue: undefined } };
          delete storageData[key];
          fireStorageChange(changes);
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener: (fn) => storageListeners.push(fn),
      },
    },
    tabs: { create: () => Promise.resolve(), sendMessage: () => Promise.resolve() },
    windows: { getLastFocused: () => Promise.resolve({ id: 1 }) },
  };

  function fireStorageChange(changes) {
    for (const fn of storageListeners.slice()) {
      try {
        fn(changes, 'local');
      } catch (err) {
        console.error(err);
      }
    }
  }

  function pick(source, keys) {
    const list = Array.isArray(keys) ? keys : Object.keys(source);
    const out = {};
    for (const key of list) {
      if (key in source) out[key] = source[key];
    }
    return out;
  }

  /** 测试脚本用来看后台收到了什么 */
  window.__fakeBackground = { log, SHOT };
})();