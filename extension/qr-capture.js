/**
 * 截屏读取二维码（内容脚本与扩展页共用）
 *
 * 为什么是「截屏」而不是「摄像头」：
 * 二维码就显示在电脑屏幕上（保险库设置页的扫码配对卡片、TOTP 之类），开摄像头
 * 对着自己的显示器纯属折腾。改成让后台用 chrome.tabs.captureVisibleTab 抓一张
 * 当前标签页的图，用户在这张图上框一下要读的码，jsQR 直接解。
 *
 * 为什么不用 BarcodeDetector：MDN 的兼容数据明确写着，Chrome 只在 Android 上
 * 实现了它，Windows / macOS / ChromeOS 桌面端从未支持。所以解码器固定用 vendor
 * 进来的 jsQR。
 *
 * 这个文件刻意不依赖任何构建步骤，且两种宿主（页面里的内容脚本 / chrome-extension
 * 扩展页）都能直接 <script> 引入，对外只暴露一个 KeyVaultQrCapture。
 */
(function (global) {
  'use strict';

  /** 整屏截图解码前的最长边。再大只会更慢，对识别率没帮助 */
  var MAX_FRAME_SIZE = 1600;
  /** 选区解码前的最长边 */
  var MAX_CROP_SIZE = 1000;
  /** 扫出来的文本长度上限，防止一张超大图把内存和存储写爆 */
  var MAX_TEXT_LENGTH = 4096;
  /** 小于这个尺寸的拖拽当成误触，忽略 */
  var MIN_SEL_SIZE = 16;
  /** 底部操作条预留高度，截图要在上面这块里居中 */
  var BAR_HEIGHT = 104;

  var decode = typeof global.jsQR === 'function' ? global.jsQR : null;

  var work = document.createElement('canvas');
  var wctx = work.getContext('2d', { willReadFrequently: true });

  /** 解码当前画布。返回空串表示没识别到 */
  function decodeCanvas() {
    if (!decode) return '';
    var imageData;
    try {
      imageData = wctx.getImageData(0, 0, work.width, work.height);
    } catch {
      // 画布被宿主页面的 CSP 污染时 getImageData 会抛 SecurityError
      return '';
    }
    var result = decode(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'attemptBoth',
    });
    if (!result || typeof result.data !== 'string') return '';
    return result.data.trim().slice(0, MAX_TEXT_LENGTH);
  }

  /** 把源图的某个矩形缩放后丢给 jsQR。坐标是源图像素 */
  function drawAndDecode(source, sx, sy, sw, sh, maxSize) {
    if (!sw || !sh) return '';
    var scale = Math.min(1, maxSize / Math.max(sw, sh));
    var w = Math.max(1, Math.round(sw * scale));
    var h = Math.max(1, Math.round(sh * scale));

    if (work.width !== w || work.height !== h) {
      work.width = w;
      work.height = h;
    }
    wctx.clearRect(0, 0, w, h);
    wctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
    return decodeCanvas();
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        resolve(img);
      };
      img.onerror = function () {
        reject(new Error('截图读取失败'));
      };
      img.src = src;
    });
  }

  /** 直接解一张完整截图（后台刚抓来的那张）。读不出来时安静地返回空串 */
  function decodeDataUrl(dataUrl) {
    return loadImage(dataUrl)
      .then(function (img) {
        return drawAndDecode(img, 0, 0, img.naturalWidth, img.naturalHeight, MAX_FRAME_SIZE);
      })
      .catch(function () {
        return '';
      });
  }

  /** 解用户挑的一张图片文件 */
  function decodeBlob(blob) {
    if (!blob) return Promise.resolve('');

    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(blob)
        .then(function (bitmap) {
          var text = drawAndDecode(bitmap, 0, 0, bitmap.width, bitmap.height, MAX_FRAME_SIZE);
          if (typeof bitmap.close === 'function') bitmap.close();
          return text;
        })
        .catch(function () {
          return decodeBlobViaImg(blob);
        });
    }
    return decodeBlobViaImg(blob);
  }

  function decodeBlobViaImg(blob) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob);
      var done = function (text) {
        URL.revokeObjectURL(url);
        resolve(text);
      };
      loadImage(url).then(
        function (img) {
          done(drawAndDecode(img, 0, 0, img.naturalWidth, img.naturalHeight, MAX_FRAME_SIZE));
        },
        function () {
          done('');
        }
      );
    });
  }

  function preventDefault(event) {
    // 取景框盖住整页时不希望滚轮把底下的页面滚走
    if (event.cancelable) event.preventDefault();
  }

  /**
   * 打开取景框。
   *
   * @param {object} options
   * @param {string} options.dataUrl     后台 captureVisibleTab 抓到的整屏截图
   * @param {Document} [options.document]
   * @param {Element}  [options.mount]   挂载点，默认 document.body
   * @param {string}   [options.hint]
   * @param {() => Promise<string>} [options.recapture]  重新截屏，返回新的 dataUrl
   * @param {(text: string) => void} options.onDecoded
   * @param {() => void} [options.onCancel]
   * @param {(message: string) => void} [options.onError]
   * @returns {{close: Function, setStatus: Function}|null}
   */
  function open(options) {
    var opts = options || {};
    var doc = opts.document || document;
    var view = doc.defaultView || global;
    var mount = opts.mount || doc.body;

    if (!decode) {
      if (typeof opts.onError === 'function') opts.onError('二维码解码器没有加载成功（vendor/jsQR.min.js）');
      return null;
    }
    if (!opts.dataUrl) {
      if (typeof opts.onError === 'function') opts.onError('没有拿到屏幕截图');
      return null;
    }

    var root = doc.createElement('div');
    root.className = 'keyvault-qr-capture';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '截屏读取二维码');
    root.innerHTML = [
      '<img class="keyvault-qr-shot" alt="">',
      '<div class="keyvault-qr-sel"></div>',
      '<div class="keyvault-qr-bar">',
      '  <div class="keyvault-qr-text">',
      '    <span class="keyvault-qr-hint"></span>',
      '    <span class="keyvault-qr-status" role="status"></span>',
      '  </div>',
      '  <div class="keyvault-qr-actions">',
      '    <button type="button" class="keyvault-qr-btn" data-act="decode">识别选区</button>',
      '    <button type="button" class="keyvault-qr-btn" data-act="full">整屏识别</button>',
      '    <button type="button" class="keyvault-qr-btn" data-act="recapture">重新截屏</button>',
      '    <button type="button" class="keyvault-qr-btn" data-act="cancel">取消</button>',
      '  </div>',
      '</div>',
    ].join('');

    var shotEl = root.querySelector('.keyvault-qr-shot');
    var selEl = root.querySelector('.keyvault-qr-sel');
    var hintEl = root.querySelector('.keyvault-qr-hint');
    var statusEl = root.querySelector('.keyvault-qr-status');
    var btnRecapture = root.querySelector('[data-act="recapture"]');

    hintEl.textContent = String(opts.hint || '拖动鼠标框住屏幕上的二维码，松开后自动识别');
    if (typeof opts.recapture !== 'function' && btnRecapture) btnRecapture.remove();

    shotEl.src = opts.dataUrl;

    var image = null;
    var sel = null;
    var drag = null;
    var closed = false;

    root.addEventListener('wheel', preventDefault, { passive: false });
    root.addEventListener('touchmove', preventDefault, { passive: false });
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerup', onPointerUp);
    root.addEventListener('pointercancel', onPointerUp);
    root.addEventListener('contextmenu', preventDefault);
    doc.addEventListener('keydown', onKeyDown, true);

    root.addEventListener('click', function (event) {
      var target = event.target;
      var act = target && target.getAttribute ? target.getAttribute('data-act') : null;
      if (!act) return;
      event.preventDefault();
      if (act === 'decode') runDecode('selection');
      else if (act === 'full') selectFull();
      else if (act === 'recapture') recapture();
      else if (act === 'cancel') cancel();
    });

    mount.appendChild(root);

    loadImage(opts.dataUrl)
      .then(function (img) {
        if (closed) return;
        image = img;
        layout();
        // 整屏先试一次：多数情况下用户只想读屏上唯一的那张码
        setStatus('正在识别整屏截图…');
        runDecode('frame');
      })
      .catch(function () {
        if (closed) return;
        setStatus('截图读取失败，可以点「重新截屏」再试一次', 'err');
      });

    // --- 内部实现 ----------------------------------------------------------

    function setStatus(message, kind) {
      if (closed || !statusEl) return;
      statusEl.textContent = message || '';
      statusEl.className =
        'keyvault-qr-status' + (kind === 'err' ? ' keyvault-qr-status-err' : kind === 'ok' ? ' keyvault-qr-status-ok' : '');
    }

    /** 截图按比例缩到「视口减去操作条」里居中 */
    function layout() {
      if (!image) return;
      var iw = image.naturalWidth || image.width;
      var ih = image.naturalHeight || image.height;
      if (!iw || !ih) return;

      var vw = view.innerWidth || doc.documentElement.clientWidth || iw;
      var vh = view.innerHeight || doc.documentElement.clientHeight || ih;
      var availW = Math.max(120, vw - 32);
      var availH = Math.max(120, vh - BAR_HEIGHT - 32);

      var scale = Math.min(1, availW / iw, availH / ih);
      var dw = Math.round(iw * scale);
      var dh = Math.round(ih * scale);

      shotEl.style.width = dw + 'px';
      shotEl.style.height = dh + 'px';
      shotEl.style.left = Math.round((vw - dw) / 2) + 'px';
      shotEl.style.top = Math.round(Math.max(8, (vh - BAR_HEIGHT - dh) / 2)) + 'px';

      sel = { x: 0, y: 0, w: dw, h: dh };
      paintSelection();
    }

    function shotRect() {
      return {
        x: parseFloat(shotEl.style.left) || 0,
        y: parseFloat(shotEl.style.top) || 0,
        w: shotEl.offsetWidth || shotEl.clientWidth || 0,
        h: shotEl.offsetHeight || shotEl.clientHeight || 0,
      };
      }

    function paintSelection() {
      if (!sel || sel.w < 1 || sel.h < 1) {
        selEl.classList.remove('keyvault-qr-sel-on');
        return;
      }
      selEl.classList.add('keyvault-qr-sel-on');
      selEl.style.left = Math.round(sel.x) + 'px';
      selEl.style.top = Math.round(sel.y) + 'px';
      selEl.style.width = Math.round(sel.w) + 'px';
      selEl.style.height = Math.round(sel.h) + 'px';
    }

    function selectFull() {
      var rect = shotRect();
      sel = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
      paintSelection();
      runDecode('frame');
    }

    function localPoint(event) {
      var rect = root.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    function clampToShot(next) {
      var rect = shotRect();
      var x1 = Math.max(rect.x, Math.min(next.x, rect.x + rect.w));
      var y1 = Math.max(rect.y, Math.min(next.y, rect.y + rect.h));
      var x2 = Math.max(rect.x, Math.min(next.x + next.w, rect.x + rect.w));
      var y2 = Math.max(rect.y, Math.min(next.y + next.h, rect.y + rect.h));
      return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
    }

    function onPointerDown(event) {
      if (closed || !image) return;
      if (typeof event.button === 'number' && event.button !== 0) return;
      if (event.target && event.target.closest && event.target.closest('.keyvault-qr-bar')) return;

      var point = localPoint(event);
      var rect = shotRect();
      var insideExisting =
        sel &&
        sel.w > 1 &&
        point.x >= sel.x &&
        point.x <= sel.x + sel.w &&
        point.y >= sel.y &&
        point.y <= sel.y + sel.h;

      if (insideExisting && !(sel.w >= rect.w - 1 && sel.h >= rect.h - 1)) {
        drag = { mode: 'move', from: point, origin: { x: sel.x, y: sel.y, w: sel.w, h: sel.h } };
      } else {
        drag = { mode: 'draw', from: point };
        sel = clampToShot({ x: point.x, y: point.y, w: 0, h: 0 });
      }
      paintSelection();

      try {
        root.setPointerCapture(event.pointerId);
      } catch {
        // 某些环境不支持指针捕获，忽略即可
      }
      event.preventDefault();
    }

    function onPointerMove(event) {
      if (closed || !drag || !image) return;
      var point = localPoint(event);

      if (drag.mode === 'move') {
        var origin = drag.origin;
        var rect = shotRect();
        var dx = point.x - drag.from.x;
        var dy = point.y - drag.from.y;
        var nx = Math.max(rect.x, Math.min(origin.x + dx, rect.x + rect.w - origin.w));
        var ny = Math.max(rect.y, Math.min(origin.y + dy, rect.y + rect.h - origin.h));
        sel = { x: nx, y: ny, w: origin.w, h: origin.h };
      } else {
        var from = drag.from;
        sel = clampToShot({
          x: Math.min(from.x, point.x),
          y: Math.min(from.y, point.y),
          w: Math.abs(point.x - from.x),
          h: Math.abs(point.y - from.y),
        });
      }
      paintSelection();
      event.preventDefault();
    }

    function onPointerUp(event) {
      if (closed || !drag) return;
      var mode = drag.mode;
      drag = null;
      try {
        root.releasePointerCapture(event.pointerId);
      } catch {
        // 忽略
      }

      // 误触（拖了一下就松手）当成没框，直接重画整屏
      if (mode === 'draw' && (!sel || sel.w < MIN_SEL_SIZE || sel.h < MIN_SEL_SIZE)) {
        selectFull();
        return;
      }
      runDecode('selection');
    }

    function onKeyDown(event) {
      if (closed) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    }

    function runDecode(scope) {
      if (closed || !image) return;
      setStatus('正在识别…');

      // jsQR 是同步的纯 CPU 计算，放到下一轮事件循环里跑，
      // 否则「正在识别…」这行字来不及画出来
      setTimeout(function () {
        if (closed || !image) return;

        var rect = shotRect();
        var iw = image.naturalWidth || image.width;
        var ih = image.naturalHeight || image.height;
        var text = '';

        try {
          if (scope === 'frame' || !sel || sel.w < 1) {
            text = drawAndDecode(image, 0, 0, iw, ih, MAX_FRAME_SIZE);
          } else {
            // 选区是屏幕坐标，换算回截图的原始像素
            var kx = iw / (rect.w || 1);
            var ky = ih / (rect.h || 1);
            text = drawAndDecode(
              image,
              (sel.x - rect.x) * kx,
              (sel.y - rect.y) * ky,
              sel.w * kx,
              sel.h * ky,
              MAX_CROP_SIZE
            );
          }
        } catch {
          text = '';
        }

        if (closed) return;
        if (text) {
          finish(text);
        } else {
          setStatus(
            scope === 'frame'
              ? '整屏没找到二维码 —— 拖动鼠标框住它再松手，或点「重新截屏」'
              : '这个选区里没有二维码，换个范围再试试',
            'err'
          );
        }
      }, 20);
    }

    function finish(text) {
      if (closed) return;
      setStatus('识别成功', 'ok');
      close();
      if (typeof opts.onDecoded === 'function') opts.onDecoded(text);
    }

    function recapture() {
      if (typeof opts.recapture !== 'function') return;
      setStatus('正在重新截屏…');
      Promise.resolve()
        .then(function () {
          return opts.recapture();
        })
        .then(function (dataUrl) {
          if (closed) return;
          if (!dataUrl) {
            setStatus('重新截屏失败，请确认二维码所在页面在前台', 'err');
            return;
          }
          shotEl.src = dataUrl;
          return loadImage(dataUrl).then(function (img) {
            if (closed) return;
            image = img;
            layout();
            setStatus('已重新截屏，拖动鼠标框住二维码', null);
          });
        })
        .catch(function (err) {
          if (closed) return;
          setStatus('重新截屏失败：' + ((err && err.message) || '未知错误'), 'err');
        });
    }

    function cancel() {
      close();
      if (typeof opts.onCancel === 'function') opts.onCancel();
    }

    function close() {
      if (closed) return;
      closed = true;
      root.remove();
      doc.removeEventListener('keydown', onKeyDown, true);
    }

    return {
      close: close,
      setStatus: setStatus,
      /** 重新截屏时把自己藏起来，免得把取景框拍进截图 */
      setHidden: function (hidden) {
        if (closed || !root) return;
        root.style.visibility = hidden ? 'hidden' : '';
      },
      isClosed: function () {
        return closed;
      },
    };
  }

  global.KeyVaultQrCapture = {
    open: open,
    decodeDataUrl: decodeDataUrl,
    decodeBlob: decodeBlob,
    hasDecoder: function () {
      return !!decode;
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);