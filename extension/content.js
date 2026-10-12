/**
 * KeyVault Chrome Extension - Content Script
 * 自动检测表单、自动填充、生成密码、自动捕获并提示保存密码
 */

(function () {
  // Prevent duplicate injection
  if (window.__keyvault_injected__) return;
  window.__keyvault_injected__ = true;

  let cachedCredentials = [];
  let isChecking = false;

  // SVG Icons
  const SHIELD_ICON_SVG = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>
      <path d="m9 12 2 2 4-4"/>
    </svg>
  `;

  /** 二维码图标：输入框内嵌按钮与悬浮窗里的扫码条目共用 */
  const QR_ICON_SVG = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="5" height="5" rx="1"/>
      <rect x="16" y="3" width="5" height="5" rx="1"/>
      <rect x="3" y="16" width="5" height="5" rx="1"/>
      <path d="M21 16h-3a2 2 0 0 0-2 2v3"/>
      <path d="M21 21v.01"/>
      <path d="M12 7v3a2 2 0 0 1-2 2H7"/>
      <path d="M3 12h.01"/>
      <path d="M12 3h.01"/>
      <path d="M12 16v.01"/>
      <path d="M16 12h1"/>
      <path d="M21 12v.01"/>
      <path d="M12 21v-1"/>
    </svg>
  `;

  /** 眼睛：密码框上的「显示 / 隐藏密码」切换按钮 */
  const EYE_ICON_SVG = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  `;

  const EYE_OFF_ICON_SVG = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/>
      <path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/>
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>
      <line x1="2" y1="2" x2="22" y2="22"/>
    </svg>
  `;

  const SAVE_ICON_SVG = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
      <polyline points="17 21 17 13 7 13 7 21"/>
      <polyline points="7 3 7 8 15 8"/>
    </svg>
  `;

  const CHECK_ICON_SVG = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
  `;

  // Robust input value setter to trigger React/Vue/Angular/Svelte synthetic events
  function setNativeValue(element, value) {
    if (!element) return;
    try {
      element.focus();
    } catch {}

    const isInput = element instanceof HTMLInputElement;
    const isTextArea = element instanceof HTMLTextAreaElement;

    // Use prototype descriptor to bypass React 16-19 / Vue 3 setter monkeypatching
    let prototypeSetter = null;
    if (isInput && window.HTMLInputElement) {
      prototypeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    } else if (isTextArea && window.HTMLTextAreaElement) {
      prototypeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    }

    const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
    const proto = Object.getPrototypeOf(element);
    const protoSetter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;

    if (prototypeSetter) {
      prototypeSetter.call(element, value);
    } else if (protoSetter && valueSetter !== protoSetter) {
      protoSetter.call(element, value);
    } else if (valueSetter) {
      valueSetter.call(element, value);
    } else {
      element.value = value;
    }

    // Modern InputEvent + Event triggers with composed: true for shadow DOM crossing
    try {
      element.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: 'insertText',
        data: value,
      }));
    } catch {}

    try {
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: 'insertText',
        data: value,
      }));
    } catch {
      element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }

    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    // Visual feedback highlight
    try {
      const origOutline = element.style.outline;
      const origTransition = element.style.transition;
      element.style.transition = 'outline 0.15s ease-in-out';
      element.style.outline = '2px solid #10b981';
      setTimeout(() => {
        element.style.outline = origOutline;
        element.style.transition = origTransition;
      }, 800);
    } catch {}
  }

  /** 密码框不在 <form> 里时（登录卡片、弹窗、底部吸底栏等），向上找一个还包含其它
   *  输入框的容器。直接退化成全文档搜索会把账号配到别的表单上去，填错地方。 */
  function findUsernameScope(pwdInput) {
    if (pwdInput.form) return pwdInput.form;
    let node = pwdInput.parentElement;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      if (node.querySelector('input:not([type="hidden"]):not([type="password"])')) return node;
    }
    return document;
  }

  // Find associated username input for a password input
  function findUsernameInput(pwdInput) {
    const scope = findUsernameScope(pwdInput);
    const inputs = Array.from(scope.querySelectorAll('input:not([type="hidden"]):not([type="password"])'));

    // Check by autocomplete/name attributes
    for (const input of inputs) {
      const name = (input.name || '').toLowerCase();
      const id = (input.id || '').toLowerCase();
      const auto = (input.autocomplete || '').toLowerCase();
      const type = (input.type || '').toLowerCase();

      if (auto.includes('username') || auto.includes('email')) return input;
      if (name.includes('user') || name.includes('email') || name.includes('login') || name.includes('account')) return input;
      if (id.includes('user') || id.includes('email') || id.includes('login') || id.includes('account')) return input;
      if (type === 'email') return input;
    }

    // Default to the input immediately preceding the password input
    const allInputs = Array.from(scope.querySelectorAll('input'));
    const pwdIndex = allInputs.indexOf(pwdInput);
    for (let i = pwdIndex - 1; i >= 0; i--) {
      const candidate = allInputs[i];
      if (candidate.type === 'text' || candidate.type === 'email' || !candidate.type) {
        return candidate;
      }
    }

    return null;
  }

  // Load credentials for the current page
  async function loadCredentials() {
    if (isChecking) return;
    isChecking = true;
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'QUERY_CREDENTIALS',
        hostname: window.location.hostname,
      });

      if (res && res.ok && Array.isArray(res.items)) {
        cachedCredentials = res.items;
      }
    } catch {
      // Background worker might be sleeping
    } finally {
      isChecking = false;
    }
  }

  /** 可以作为「用户名」入口绑定的输入框类型（避免误绑到复选框、下拉、日期等） */
  const USERNAME_INPUT_TYPES = ['text', 'email', 'tel', 'url', 'search', ''];

  function isBindableUsernameInput(input) {
    return (
      input instanceof HTMLInputElement &&
      !input.hasAttribute('data-keyvault-bound') &&
      !input.hasAttribute('data-keyvault-user-bound') &&
      USERNAME_INPUT_TYPES.includes((input.type || '').toLowerCase()) &&
      !input.disabled &&
      !input.readOnly
    );
  }

  /**
   * 给一个输入框挂上入口。
   * 密码框与它关联的用户名框都会绑定 —— 填账号时先点用户名框更符合直觉。
   *
   * 入口改成输入框右缘的内嵌图标按钮（点它开扫码器），而不是一块常驻的深色
   * 徽章。按钮默认透明且不接收指针事件，只有输入框被悬停/聚焦时才淡入，
   * 平时页面上什么都看不见，也不会吃掉一次正常的点击。
   */
  function bindInputTrigger(anchorInput, pwdInput, userInput, options) {
    const opts = options || {};
    if (anchorInput === pwdInput) {
      anchorInput.setAttribute('data-keyvault-bound', 'true');
    } else {
      anchorInput.setAttribute('data-keyvault-user-bound', 'true');
    }

    const trigger = createInlineButton(anchorInput, QR_ICON_SVG, '密码保险库 - 读取屏幕上的二维码', 0);
    const buttons = [trigger];

    // 阻止 mousedown 默认行为：否则按下按钮时输入框会先 blur，按钮会先消失
    trigger.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openQrScanner(anchorInput);
    });

    // 密码框上再加一个「显示 / 隐藏密码」的眼睛按钮，并排在扫码按钮左侧
    if (opts.eye) {
      const eye = createInlineButton(anchorInput, EYE_ICON_SVG, '显示密码', 1);
      eye.setAttribute('aria-pressed', 'false');

      eye.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      eye.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        togglePasswordVisibility(anchorInput, eye);
      });

      buttons.push(eye);
    }

    bindInlineVisibility(anchorInput, buttons);

    const open = () => {
      // 输入框或其配对密码框已被页面移除时不再弹出
      if (!anchorInput.isConnected) return;
      if (pwdInput && !pwdInput.isConnected) return;
      showDropdown(pwdInput, userInput, anchorInput);
    };

    // focus 与 click 都会触发，showDropdown 内部有同锚点去重
    anchorInput.addEventListener('focus', open);
    anchorInput.addEventListener('click', open);
  }

  /** 造一个输入框右缘的内嵌图标按钮。offset=0 是最右（扫码），1 是往左一格 */
  function createInlineButton(anchorInput, iconSvg, label, offset) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.tabIndex = -1;
    btn.className = 'keyvault-inline-btn';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = iconSvg;
    positionInlineButton(btn, anchorInput, offset);
    return btn;
  }

  /** 输入框被悬停/聚焦时才让这组按钮淡入 */
  function bindInlineVisibility(anchorInput, buttons) {
    const show = () => buttons.forEach((btn) => btn.classList.add('keyvault-inline-visible'));
    const hide = (e) => {
      // 鼠标从输入框移到按钮本身上时不能收起，否则用户还没点下去按钮就消失了
      if (e && buttons.some((btn) => e.relatedTarget === btn)) return;
      buttons.forEach((btn) => btn.classList.remove('keyvault-inline-visible'));
    };

    buttons.forEach((btn) => {
      btn.addEventListener('mouseenter', show);
      btn.addEventListener('mouseleave', hide);
    });
    anchorInput.addEventListener('mouseenter', show);
    anchorInput.addEventListener('mouseleave', hide);
    anchorInput.addEventListener('focus', show);
    anchorInput.addEventListener('blur', hide);
  }

  /** 显示 / 隐藏密码：只改 type，所以得把光标位置记下来，否则会跳到末尾 */
  function togglePasswordVisibility(input, btn) {
    const revealed = input.getAttribute('data-keyvault-revealed') === 'true';
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const next = !revealed;

    input.setAttribute('data-keyvault-revealed', next ? 'true' : 'false');
    input.type = next ? 'text' : 'password';

    try {
      if (typeof start === 'number') input.setSelectionRange(start, end);
    } catch {
      // 个别浏览器切 type 后 setSelectionRange 会抛，忽略
    }

    btn.innerHTML = next ? EYE_OFF_ICON_SVG : EYE_ICON_SVG;
    btn.title = next ? '隐藏密码' : '显示密码';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', next ? 'true' : 'false');
  }

  /** 找出尚未绑定的密码框（及其关联的用户名框）并挂上入口 */
  function attachInputTriggers() {
    const passwordInputs = document.querySelectorAll('input[type="password"]:not([data-keyvault-bound])');

    passwordInputs.forEach((pwdInput) => {
      const userInput = findUsernameInput(pwdInput);

      bindInputTrigger(pwdInput, pwdInput, userInput, { eye: true });

      // 用户名输入框使用独立标记，避免与密码框的绑定标记互相干扰
      if (isBindableUsernameInput(userInput)) {
        bindInputTrigger(userInput, pwdInput, userInput);
      }
    });
  }

  // --- 浮层定位 ------------------------------------------------------------
  // 内嵌按钮要跟着输入框走，就必须是 position: fixed。但只要挂载点的祖先里有
  // transform / filter / contain，fixed 就会改为相对那个祖先定位，页面一滚
  // 整块浮层就跟着飘走、停在屏幕中间。所以先探一个干净挂载点。
  let floatingHost = null;

  /** 固定定位会不会被这个元素改成「相对它定位」 */
  function breaksFixed(el) {
    if (!el || el === document.documentElement) return true;
    const cs = getComputedStyle(el);
    return (
      cs.transform !== 'none' ||
      cs.filter !== 'none' ||
      cs.perspective !== 'none' ||
      /paint|layout|strict|content/.test(cs.contain || '')
    );
  }

  /** 页面随时可能给 body 加上 transform（常见的 GPU 合成小技巧），所以每次重算
   *  都重新确认挂载点还干不干净，不合适就把浮层搬到更外层去。 */
  function getFloatingHost() {
    const target = breaksFixed(document.body) ? document.documentElement : document.body;

    if (!floatingHost || !floatingHost.isConnected) {
      floatingHost = document.createElement('div');
      floatingHost.id = 'keyvault-floating-layer';
      floatingHost.setAttribute('aria-hidden', 'true');
      floatingHost.style.cssText =
        'position:static;margin:0;padding:0;border:0;width:0;height:0;overflow:visible;';
    } else if (floatingHost.parentElement === target) {
      return floatingHost;
    }

    target.appendChild(floatingHost);
    return floatingHost;
  }

  function mountFloatingLayer(el) {
    getFloatingHost().appendChild(el);
    return el;
  }

  /** 所有内嵌按钮：{ trigger, input }。统一登记，统一重算，避免每个各挂一份监听器。 */
  const triggerRegistry = new Set();
  let repositionScheduled = false;

  function scheduleReposition() {
    if (repositionScheduled) return;
    repositionScheduled = true;

    const run = () => {
      if (!repositionScheduled) return;
      repositionScheduled = false;
      repositionTriggers();
      positionCurrentDropdown();
    };

    // rAF 在页面不可见或被节流时可能长时间不触发，兜底再补一个定时器；
    // 否则后台标签页里浮层会彻底失去跟随能力
    requestAnimationFrame(run);
    setTimeout(run, 16);
  }

  function repositionTriggers() {
    // 顺便重新确认一下挂载点没被页面改坏
    getFloatingHost();

    for (const entry of triggerRegistry) {
      const { trigger, input, offset } = entry;

      // 输入框被 SPA 换掉后立刻回收，否则按钮会变成一个飘在屏幕中间、
      // 又挡点击又删不掉的东西
      if (!input.isConnected) {
        trigger.remove();
        triggerRegistry.delete(entry);
        continue;
      }

      const rect = input.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || rect.top < -50 || rect.bottom > window.innerHeight + 50) {
        trigger.style.display = 'none';
        continue;
      }

      // 内嵌在输入框右缘：尺寸跟着输入框高度走，太高的输入框也不会显得突兀
      const size = Math.round(Math.min(24, Math.max(16, rect.height - 10)));
      // 一排两个按钮时（密码框的「扫码 + 眼睛」），左边的那个整体往左挪一格
      const shift = (offset || 0) * (size + 2);

      trigger.style.display = 'flex';
      trigger.style.position = 'fixed';
      trigger.style.width = `${size}px`;
      trigger.style.height = `${size}px`;
      trigger.style.top = `${rect.top + (rect.height - size) / 2}px`;
      trigger.style.left = `${Math.max(0, rect.right - size - 4 - shift)}px`;
      trigger.style.zIndex = '2147483640';
    }
  }

  function positionInlineButton(trigger, input, offset) {
    mountFloatingLayer(trigger);
    triggerRegistry.add({ trigger, input, offset: offset || 0 });
    repositionTriggers();
  }

  // Floating dropdown for filling or generating password
  function showDropdown(pwdInput, userInput, anchorInput) {
    // 一次点击会先触发 focus 再触发 click；同一锚点已打开时直接复用，避免重复重建
    const existing = document.getElementById('keyvault-dropdown');
    if (existing && currentDropdownAnchor === anchorInput) return;

    removeExistingDropdown();
    currentDropdownAnchor = anchorInput;

    const dropdown = document.createElement('div');
    dropdown.id = 'keyvault-dropdown';
    dropdown.className = 'keyvault-floating-dropdown';

    let contentHtml = `
      <div class="keyvault-dropdown-header">密码保险库</div>
      <div class="keyvault-dropdown-item keyvault-action-scan" id="keyvault-btn-scan">
        <span class="keyvault-item-icon">${QR_ICON_SVG}</span>
        <span>截屏读取二维码</span>
      </div>
      <div class="keyvault-dropdown-divider"></div>
    `;

    if (cachedCredentials.length > 0) {
      contentHtml += `<div class="keyvault-dropdown-section-title">匹配的已保存账号</div>`;
      cachedCredentials.forEach((item, index) => {
        contentHtml += `
          <div class="keyvault-dropdown-item" data-index="${index}">
            <div class="keyvault-dropdown-username">${escapeHtml(item.username)}</div>
            <div class="keyvault-dropdown-site">${escapeHtml(item.site || window.location.hostname)}</div>
          </div>
        `;
      });
    }

    contentHtml += `
      <div class="keyvault-dropdown-divider"></div>
      <div class="keyvault-dropdown-item keyvault-action-remember" id="keyvault-btn-remember">
        <span class="keyvault-item-icon">${SAVE_ICON_SVG}</span>
        <span>记住此网站账号密码...</span>
      </div>
      <div class="keyvault-dropdown-item keyvault-action-generate" id="keyvault-btn-generate">
        <span class="keyvault-item-icon">${SHIELD_ICON_SVG}</span>
        <span>生成高强度随机密码</span>
      </div>
    `;

    dropdown.innerHTML = contentHtml;
    dropdown.style.position = 'fixed';
    dropdown.style.zIndex = '2147483647';
    currentDropdownEl = dropdown;
    mountFloatingLayer(dropdown);
    positionCurrentDropdown();

    // Click 读取二维码
    const scanBtn = dropdown.querySelector('#keyvault-btn-scan');
    if (scanBtn) {
      scanBtn.addEventListener('click', () => {
        removeExistingDropdown();
        openQrScanner(anchorInput);
      });
    }

    // Click account to autofill
    dropdown.querySelectorAll('.keyvault-dropdown-item[data-index]').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.getAttribute('data-index'), 10);
        const cred = cachedCredentials[idx];
        if (cred) {
          if (userInput) setNativeValue(userInput, cred.username);
          if (pwdInput) setNativeValue(pwdInput, cred.password);
          showToast(`已自动填充「${cred.username}」`);
        }
        removeExistingDropdown();
      });
    });

    // Click remember current account & password
    const rememberBtn = dropdown.querySelector('#keyvault-btn-remember');
    if (rememberBtn) {
      rememberBtn.addEventListener('click', () => {
        removeExistingDropdown();
        const currentUsername = userInput ? userInput.value.trim() : '';
        const currentPassword = pwdInput ? pwdInput.value : '';
        showSavePrompt({
          site: document.title || window.location.hostname,
          url: window.location.href,
          username: currentUsername,
          password: currentPassword,
        }, true);
      });
    }

    // Click generate password
    const genBtn = dropdown.querySelector('#keyvault-btn-generate');
    if (genBtn) {
      genBtn.addEventListener('click', async () => {
        try {
          const res = await chrome.runtime.sendMessage({
            type: 'GENERATE_PASSWORD',
            options: { length: 20, uppercase: true, lowercase: true, numbers: true, symbols: true },
          });
          if (res && res.ok && res.password) {
            setNativeValue(pwdInput, res.password);
            try {
              await navigator.clipboard.writeText(res.password);
              showToast('强密码已生成并填入（已复制到剪贴板）');
            } catch {
              showToast('强密码已生成并填入');
            }
          }
        } catch (err) {
          console.error(err);
        }
        removeExistingDropdown();
      });
    }

    // Dismiss on outside click
    // 判定时必须把触发它的输入框也算作「内部」：真实点击时 mousedown 与 click
    // 之间可能超过下面这个延时，否则刚弹出就会被自己判成点击外部而关闭。
    setTimeout(() => {
      // 10ms 内可能已被新的一次点击换掉了锚点，此时这个监听器已经过期，直接丢弃
      if (!dropdown.isConnected) return;

      const onDocClick = (e) => {
        const target = e.target;
        const inside =
          dropdown.contains(target) ||
          target === anchorInput ||
          target === pwdInput ||
          target === userInput;
        if (!inside) removeExistingDropdown();
      };

      currentDropdownDismiss = onDocClick;
      document.addEventListener('click', onDocClick);

      // Esc 直接关掉，别逼用户非得点空白处
      const onKeyDown = (e) => {
        if (e.key === 'Escape') removeExistingDropdown();
      };
      currentDropdownEsc = onKeyDown;
      document.addEventListener('keydown', onKeyDown, true);
    }, 10);
  }

  /** 当前悬浮窗的锚点，用于 focus/click 去重 */
  let currentDropdownAnchor = null;
  let currentDropdownEl = null;
  /** 当前悬浮窗挂在 document 上的「点击外部关闭」监听器，必须随悬浮窗一起解绑 */
  let currentDropdownDismiss = null;
  /** Esc 关闭用的 keydown 监听器 */
  let currentDropdownEsc = null;

  const VIEWPORT_MARGIN = 8;

  /** 贴在锚点旁，并保证整个面板留在视口内：贴底时向上弹，贴边时横向收回来 */
  function positionCurrentDropdown() {
    const dropdown = currentDropdownEl;
    const anchor = currentDropdownAnchor;
    if (!dropdown || !anchor || !dropdown.isConnected) return;

    if (!anchor.isConnected) {
      removeExistingDropdown();
      return;
    }

    const anchorRect = anchor.getBoundingClientRect();

    // 锚点被滚出视口后面板已经没有参照了，直接关掉而不是留在屏幕中间
    const anchorVisible =
      anchorRect.bottom > 0 &&
      anchorRect.top < window.innerHeight &&
      anchorRect.right > 0 &&
      anchorRect.left < window.innerWidth;
    if (!anchorVisible) {
      removeExistingDropdown();
      return;
    }

    // 用 offsetWidth/Height 而不是 getBoundingClientRect：入场动画带 scale 会被后者算进去
    const width = dropdown.offsetWidth;
    const height = dropdown.offsetHeight;

    let top = anchorRect.bottom + 6;
    if (top + height > window.innerHeight - VIEWPORT_MARGIN) {
      const above = anchorRect.top - height - 6;
      top = above >= VIEWPORT_MARGIN
        ? above
        : Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
    }

    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(VIEWPORT_MARGIN, anchorRect.right - width), maxLeft);

    dropdown.style.top = `${Math.round(top)}px`;
    dropdown.style.left = `${Math.round(left)}px`;
  }

  function removeExistingDropdown() {
    if (currentDropdownDismiss) {
      document.removeEventListener('click', currentDropdownDismiss);
      currentDropdownDismiss = null;
    }
    if (currentDropdownEsc) {
      document.removeEventListener('keydown', currentDropdownEsc, true);
      currentDropdownEsc = null;
    }
    const old = document.getElementById('keyvault-dropdown');
    if (old) old.remove();
    currentDropdownEl = null;
    currentDropdownAnchor = null;
  }

  // --- 截屏读取二维码 -------------------------------------------------------
  /** 扫完要把文本填回哪个输入框。跨标签页拿不到对象引用，所以先记下 */
  let qrScanTargetInput = null;
  /** 扫码页（另一个标签页）回传结果时用的中转键 */
  const QR_SCAN_RESULT_KEY = 'keyvaultScanResult';
  let qrCaptureController = null;

  /**
   * 截屏扫码。
   *
   * 二维码本来就显示在屏幕上（保险库设置页的扫码配对卡片、TOTP 之类），开摄像头
   * 对着自己的显示器纯属折腾。所以后台用 captureVisibleTab 抓一张当前标签页的
   * 可见区域，再在页面上盖一层取景框，用户框住要读的码即可。扫到的内容分两路：
   *  - 保险库配对链接（<base>/?pair=<token>）→ 换一把 API Key 写进扩展配置；
   *  - 其它文本 → 填回发起扫码的那个输入框。
   */
  async function openQrScanner(targetInput) {
    removeExistingDropdown();
    qrScanTargetInput = targetInput && targetInput.isConnected ? targetInput : null;
    closeQrCapture();

    if (!window.KeyVaultQrCapture || !window.KeyVaultQrCapture.hasDecoder()) {
      showToast('二维码解码器没有加载成功', true);
      qrScanTargetInput = null;
      return;
    }

    try {
      const res = await chrome.runtime.sendMessage({ type: 'SCREEN_QR_CAPTURE' });
      if (!res || res.ok === false) {
        showToast((res && res.error) || '无法截取屏幕', true);
        qrScanTargetInput = null;
      }
    } catch {
      showToast('无法截取屏幕', true);
      qrScanTargetInput = null;
    }
  }

  /** 后台把截图推回来，这时才盖取景框 */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'SCREEN_QR_CAPTURE') return undefined;
    // 必须同步回一句，否则后台那边的 sendMessage 会以「端口提前关闭」失败
    sendResponse({ ok: showQrCapture(message.dataUrl) });
    return false;
  });

  function showQrCapture(dataUrl) {
    closeQrCapture();

    qrCaptureController = window.KeyVaultQrCapture.open({
      document,
      mount: getFloatingHost(),
      dataUrl,
      hint: '在屏幕截图里拖动鼠标框住二维码，松手后自动识别',
      recapture: recaptureScreen,
      onDecoded: (text) => {
        closeQrCapture();
        routeScannedText(text);
      },
      onCancel: () => {
        qrScanTargetInput = null;
      },
      onError: (message) => {
        qrScanTargetInput = null;
        showToast(message || '无法显示取景框', true);
      },
    });

    if (!qrCaptureController) qrScanTargetInput = null;
    return !!qrCaptureController;
  }

  /** 重新截屏：得先把取景框藏起来，否则会把取景框本身也拍进去 */
  async function recaptureScreen() {
    const controller = qrCaptureController;
    if (controller && controller.setHidden) controller.setHidden(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const res = await chrome.runtime.sendMessage({ type: 'CAPTURE_THIS_TAB' });
      if (!res || res.ok !== true) throw new Error((res && res.error) || '截屏失败');
      return res.dataUrl;
    } finally {
      if (controller && !controller.isClosed()) controller.setHidden(false);
    }
  }

  function closeQrCapture() {
    if (qrCaptureController) {
      qrCaptureController.close();
      qrCaptureController = null;
    }
  }

  /** 扫到的文本分流：配对码去换密钥，其它文本直接填回输入框 */
  async function routeScannedText(text) {
    const parsed = parsePairPayload(text);

    if (!parsed) {
      fillScannedText(text);
      return;
    }

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'REDEEM_PAIR_TOKEN',
        payload: { token: parsed.token, baseUrl: parsed.baseUrl || '' },
      });
      qrScanTargetInput = null;
      if (res && res.ok) showToast('已连接到保险库，扩展配置已更新');
      else showToast((res && res.error) || '配对失败', true);
    } catch {
      showToast('配对失败：扩展后台没有响应', true);
    }
  }

  /** 与 popup.js / scanner.js 的同名函数保持一致：完整配对链接或裸配对码 */
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

  /** 把扫到的普通文本填回输入框（目标已消失时退回当前焦点） */
  function fillScannedText(text) {
    const target =
      qrScanTargetInput && qrScanTargetInput.isConnected
        ? qrScanTargetInput
        : document.activeElement;
    qrScanTargetInput = null;

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      setNativeValue(target, text);
      showToast('二维码内容已填入输入框');
    } else {
      navigator.clipboard?.writeText(text).catch(() => {});
      showToast('二维码内容已复制到剪贴板');
    }
  }

  // 扫码页在另一个标签页里，扫到的普通文本只能靠 storage 中转回来
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const scanned = changes[QR_SCAN_RESULT_KEY]?.newValue;
    if (scanned && typeof scanned.text === 'string') {
      fillScannedText(scanned.text);
      // 用完即清，否则下次扫描前这个旧值会先被当成一次新结果
      chrome.storage.local.remove(QR_SCAN_RESULT_KEY).catch(() => {});
    }
  });

  // --- Auto Capture & Prompt to Save Password ---
  let lastCapturedCred = null;

  function monitorFormSubmissions() {
    // 1. Listen to form submits
    document.addEventListener('submit', (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      captureFromForm(form);
    }, true);

    // 2. Listen to Enter in password inputs
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type === 'password') {
        const form = e.target.form || e.target.closest('form');
        if (form) {
          captureFromForm(form);
        } else {
          captureSingle(e.target);
        }
      }
    }, true);

    // 3. Listen to submit button clicks
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button, input[type="submit"]');
      if (!btn) return;
      const form = btn.form || btn.closest('form');
      if (form) {
        captureFromForm(form);
      }
    }, true);
  }

  function captureFromForm(form) {
    const pwdInput = form.querySelector('input[type="password"]');
    if (!pwdInput || !pwdInput.value) return;

    const userInput = findUsernameInput(pwdInput);
    const username = userInput ? userInput.value.trim() : '';
    const password = pwdInput.value;

    if (!password) return;

    lastCapturedCred = {
      site: document.title || window.location.hostname,
      url: window.location.href,
      username,
      password,
    };

    // Show prompt with a small delay so user sees submission
    setTimeout(() => {
      showSavePrompt(lastCapturedCred);
    }, 800);
  }

  function captureSingle(pwdInput) {
    if (!pwdInput || !pwdInput.value) return;
    const userInput = findUsernameInput(pwdInput);
    const username = userInput ? userInput.value.trim() : '';

    lastCapturedCred = {
      site: document.title || window.location.hostname,
      url: window.location.href,
      username,
      password: pwdInput.value,
    };

    setTimeout(() => {
      showSavePrompt(lastCapturedCred);
    }, 800);
  }

  // --- Remember Password / Account Confirmation Modal ---
  async function showSavePrompt(cred, forceShow = false) {
    if (!cred) return;
    if (!forceShow && !cred.password) return;

    const hostname = window.location.hostname;

    // Check if domain is ignored by user
    if (!forceShow) {
      const checkRes = await chrome.runtime.sendMessage({
        type: 'CHECK_DOMAIN_IGNORED',
        domain: hostname,
      });
      if (checkRes && checkRes.ignored) return;
    }

    // Check if existing credential exists in cache for this username
    const existing = cachedCredentials.find((c) => {
      const cUser = (c.username || '').trim().toLowerCase();
      const nUser = (cred.username || '').trim().toLowerCase();
      return cUser === nUser;
    });

    // If exact same username & password already saved and not manual click, skip prompt
    if (!forceShow && existing && existing.password === cred.password) {
      return;
    }

    const isUpdate = !!(existing && existing.password !== cred.password);
    const existingId = existing?.id;

    // Remove any previous prompt or backdrop
    const oldPrompt = document.getElementById('keyvault-save-prompt');
    if (oldPrompt) oldPrompt.remove();
    const oldBackdrop = document.getElementById('keyvault-save-backdrop');
    if (oldBackdrop) oldBackdrop.remove();

    // Create backdrop overlay
    const backdrop = document.createElement('div');
    backdrop.id = 'keyvault-save-backdrop';
    backdrop.className = 'keyvault-confirm-backdrop';
    document.body.appendChild(backdrop);

    // Create modal banner
    const banner = document.createElement('div');
    banner.id = 'keyvault-save-prompt';
    banner.className = 'keyvault-save-banner';

    const titleText = isUpdate ? '更新密码确认' : '记住密码确认';
    const badgeHtml = isUpdate
      ? '<span class="keyvault-badge-tag keyvault-badge-update">更新</span>'
      : '<span class="keyvault-badge-tag">记住</span>';
    const subText = isUpdate
      ? (cred.username ? `检测到账号「${escapeHtml(cred.username)}」的密码已发生变更` : `检测到此网站的密码已发生变更`)
      : `是否将此网站的密码保存到密码保险库？`;
    const saveBtnText = isUpdate ? '确认更新密码' : '确认记住并保存';

    banner.innerHTML = `
      <div class="keyvault-banner-card">
        <div class="keyvault-banner-header">
          <div class="keyvault-banner-icon">${SHIELD_ICON_SVG}</div>
          <div class="keyvault-banner-title-box">
            <div class="keyvault-banner-title-row">
              <span class="keyvault-banner-title">${titleText}</span>
              ${badgeHtml}
            </div>
            <div class="keyvault-banner-subtitle">${subText}</div>
          </div>
          <button class="keyvault-banner-close" id="keyvault-banner-close">&times;</button>
        </div>
        <div class="keyvault-banner-body">
          <div class="keyvault-banner-field">
            <label>网站标识</label>
            <input type="text" id="keyvault-save-site" value="${escapeHtml(cred.site || hostname)}" />
          </div>
          <div class="keyvault-banner-field">
            <label>账号 / 用户名（可选）</label>
            <input type="text" id="keyvault-save-username" value="${escapeHtml(cred.username || '')}" placeholder="输入账号或留空" />
          </div>
          <div class="keyvault-banner-field">
            <label>密码</label>
            <div class="keyvault-password-wrapper">
              <input type="password" id="keyvault-save-password" value="${escapeHtml(cred.password)}" placeholder="输入密码" />
              <button type="button" class="keyvault-eye-btn" id="keyvault-eye-toggle">👁️</button>
            </div>
          </div>
          <label class="keyvault-checkbox-row">
            <input type="checkbox" id="keyvault-opt-never-ask" />
            <span>对此网站不再提示保存</span>
          </label>
        </div>
        <div class="keyvault-banner-footer">
          <button class="keyvault-btn-cancel" id="keyvault-banner-cancel">暂不记住</button>
          <button class="keyvault-btn-save" id="keyvault-banner-save">${saveBtnText}</button>
        </div>
      </div>
    `;

    document.body.appendChild(banner);

    // Toggle password mask
    const eyeBtn = banner.querySelector('#keyvault-eye-toggle');
    const pwdEl = banner.querySelector('#keyvault-save-password');
    if (eyeBtn && pwdEl) {
      eyeBtn.addEventListener('click', () => {
        pwdEl.type = pwdEl.type === 'password' ? 'text' : 'password';
      });
    }

    // Dismiss helper
    const dismiss = () => {
      banner.classList.add('keyvault-fade-out');
      backdrop.style.opacity = '0';
      backdrop.style.transition = 'opacity 0.2s';
      setTimeout(() => {
        banner.remove();
        backdrop.remove();
      }, 200);
    };

    // Close on backdrop click
    backdrop.addEventListener('click', dismiss);

    // Close / Cancel buttons
    const closeBtn = banner.querySelector('#keyvault-banner-close');
    const cancelBtn = banner.querySelector('#keyvault-banner-cancel');
    const neverAskCb = banner.querySelector('#keyvault-opt-never-ask');

    async function handleNeverAskIfChecked() {
      if (neverAskCb && neverAskCb.checked) {
        await chrome.runtime.sendMessage({
          type: 'IGNORE_DOMAIN',
          domain: hostname,
        });
      }
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', async () => {
        await handleNeverAskIfChecked();
        dismiss();
      });
    }
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async () => {
        await handleNeverAskIfChecked();
        dismiss();
      });
    }

    // Save / Update Confirm
    const saveBtn = banner.querySelector('#keyvault-banner-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const finalSite = banner.querySelector('#keyvault-save-site').value.trim() || hostname;
        const finalUser = banner.querySelector('#keyvault-save-username').value.trim();
        const finalPwd = banner.querySelector('#keyvault-save-password').value;

        if (!finalPwd) {
          showToast('密码不能为空');
          return;
        }

        saveBtn.disabled = true;
        saveBtn.innerText = '正在保存...';

        await handleNeverAskIfChecked();

        try {
          const res = await chrome.runtime.sendMessage({
            type: 'SAVE_CREDENTIAL',
            id: isUpdate ? existingId : undefined,
            site: finalSite,
            url: cred.url || window.location.href,
            username: finalUser,
            password: finalPwd,
          });

          if (res && res.ok) {
            banner.querySelector('.keyvault-banner-card').innerHTML = `
              <div class="keyvault-save-success">
                <div class="keyvault-success-icon">${CHECK_ICON_SVG}</div>
                <div class="keyvault-success-text">${isUpdate ? '已成功更新密码！' : '已成功记住密码账号！'}</div>
              </div>
            `;
            // Refresh local cache
            if (isUpdate && existing) {
              existing.password = finalPwd;
              existing.site = finalSite;
            } else {
              cachedCredentials.push({
                id: res.data?.id,
                site: finalSite,
                username: finalUser,
                password: finalPwd,
              });
            }
            setTimeout(dismiss, 1200);
          } else {
            showToast('保存失败: ' + (res?.error || '请检查 API 密钥'));
            saveBtn.disabled = false;
            saveBtn.innerText = saveBtnText;
          }
        } catch (err) {
          showToast('保存失败: ' + err.message);
          saveBtn.disabled = false;
          saveBtn.innerText = saveBtnText;
        }
      });
    }
  }

  // Toast notification
  function showToast(msg, kind) {
    const old = document.getElementById('keyvault-toast');
    if (old) old.remove();

    const toast = document.createElement('div');
    toast.id = 'keyvault-toast';
    toast.className = 'keyvault-toast' + (kind ? ' keyvault-toast-error' : '');
    toast.innerText = msg;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('keyvault-toast-visible');
    }, 10);

    setTimeout(() => {
      toast.classList.remove('keyvault-toast-visible');
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }

  // Listen to background messages
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'PAIR_CONNECTED') {
      showToast('扫码配对成功，扩展已连接到保险库');
      loadCredentials();
    } else if (message.type === 'FILL_GENERATED_PASSWORD') {
      const activeEl = document.activeElement;
      if (activeEl instanceof HTMLInputElement && (activeEl.type === 'password' || activeEl.type === 'text')) {
        setNativeValue(activeEl, message.password);
        showToast('已填入强随机密码');
        return;
      }

      const pwdInputs = Array.from(document.querySelectorAll('input[type="password"]')).filter(
        (el) => el.offsetParent !== null && !el.disabled && !el.readOnly
      );

      if (pwdInputs.length > 0) {
        // If registration form with password + confirm password, fill both
        setNativeValue(pwdInputs[0], message.password);
        if (pwdInputs.length > 1) {
          const second = pwdInputs[1];
          const nameOrId = ((second.name || '') + ' ' + (second.id || '')).toLowerCase();
          if (nameOrId.includes('confirm') || nameOrId.includes('repeat') || nameOrId.includes('re') || pwdInputs.length === 2) {
            setNativeValue(second, message.password);
          }
        }
        showToast('已填入强随机密码');
      } else {
        const fallback = document.querySelector(
          'input[name*="pass" i], input[id*="pass" i], input[autocomplete*="password" i]'
        );
        if (fallback instanceof HTMLInputElement) {
          setNativeValue(fallback, message.password);
          showToast('已填入强随机密码');
        } else {
          showToast('未找到密码框，请先点击聚焦到目标输入框');
        }
      }
    } else if (message.type === 'FILL_CREDENTIAL') {
      const { username, password } = message;
      const pwdInputs = Array.from(document.querySelectorAll('input[type="password"]')).filter(
        (el) => el.offsetParent !== null && !el.disabled && !el.readOnly
      );
      const pwdInput = pwdInputs[0] || document.querySelector('input[type="password"]');

      if (pwdInput) {
        const userInput = findUsernameInput(pwdInput);
        if (userInput && username) setNativeValue(userInput, username);
        if (password) setNativeValue(pwdInput, password);
        showToast('已填入账号和密码');
      } else {
        const fallbackUser = document.querySelector(
          'input[type="email"], input[autocomplete="username"], input[name*="user" i], input[name*="email" i], input[name*="account" i]'
        );
        if (fallbackUser instanceof HTMLInputElement && username) {
          setNativeValue(fallbackUser, username);
          showToast('已填入账号（当前页未发现密码输入框）');
        } else {
          showToast('未在当前网页找到密码输入框');
        }
      }
    }
  });

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Init
  loadCredentials().then(() => {
    attachInputTriggers();
    monitorFormSubmissions();

    // 内层可滚动容器的 scroll 不会冒泡到 window，只挂 window 的话，
    // 滚动页面里的某个盒子时按钮会停在原地，变成飘在屏幕中间的点不掉的东西。
    // 捕获阶段挂在 document 上才能接住所有来源的滚动；页面自身的滚动另外在
    // window 上再挂一份，两边不冲突（scheduleReposition 内部会合并重复调用）。
    document.addEventListener('scroll', scheduleReposition, { capture: true, passive: true });
    window.addEventListener('scroll', scheduleReposition, { passive: true });
    window.addEventListener('resize', scheduleReposition, { passive: true });

    // Observe dynamic elements (SPAs)
    const observer = new MutationObserver(() => {
      attachInputTriggers();
      scheduleReposition();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
