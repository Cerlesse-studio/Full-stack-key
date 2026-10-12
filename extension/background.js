/**
 * KeyVault Chrome Extension - Background Service Worker (Manifest V3)
 */

const DEFAULT_CONFIG = {
  apiUrl: 'http://localhost:3000',
  apiKey: '',
  masterPassword: '',
};

// Initialize default storage on install
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(['apiUrl', 'apiKey', 'masterPassword']);
  if (!current.apiUrl) {
    await chrome.storage.local.set(DEFAULT_CONFIG);
  }

  // Create context menus
  chrome.contextMenus.create({
    id: 'keyvault-generate',
    title: '🔐 生成高强度随机密码',
    contexts: ['editable', 'page'],
  });

  chrome.contextMenus.create({
    id: 'keyvault-open-vault',
    title: '🗂️ 打开密码保险库设置',
    contexts: ['action'],
  });
});

// Handle context menus
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'keyvault-generate') {
    const password = generatePassword({ length: 20, uppercase: true, lowercase: true, numbers: true, symbols: true });
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'FILL_GENERATED_PASSWORD',
        password,
      });
    }
  } else if (info.menuItemId === 'keyvault-open-vault') {
    chrome.runtime.openOptionsPage();
  }
});

// Helper: Normalize API Base URL
function cleanUrl(url) {
  if (!url) return 'http://localhost:3000';
  let cleaned = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = 'http://' + cleaned;
  }
  return cleaned;
}

// Helper: Generate Secure Password
function generatePassword(options = {}) {
  const length = Math.max(8, Math.min(64, options.length || 20));
  const uppercase = options.uppercase !== false;
  const lowercase = options.lowercase !== false;
  const numbers = options.numbers !== false;
  const symbols = options.symbols !== false;

  const upperChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lowerChars = 'abcdefghijkmnopqrstuvwxyz';
  const numberChars = '23456789';
  const symbolChars = '!@#$%^&*()_+-=[]{}|;:,.<>?';

  let pool = '';
  const guaranteed = [];

  if (uppercase) {
    pool += upperChars;
    guaranteed.push(upperChars[Math.floor(Math.random() * upperChars.length)]);
  }
  if (lowercase) {
    pool += lowerChars;
    guaranteed.push(lowerChars[Math.floor(Math.random() * lowerChars.length)]);
  }
  if (numbers) {
    pool += numberChars;
    guaranteed.push(numberChars[Math.floor(Math.random() * numberChars.length)]);
  }
  if (symbols) {
    pool += symbolChars;
    guaranteed.push(symbolChars[Math.floor(Math.random() * symbolChars.length)]);
  }

  if (!pool) pool = lowerChars + numberChars;

  const array = new Uint32Array(length);
  crypto.getRandomValues(array);

  const result = [...guaranteed];
  for (let i = guaranteed.length; i < length; i++) {
    result.push(pool[array[i] % pool.length]);
  }

  // Shuffle
  for (let i = result.length - 1; i > 0; i--) {
    const j = array[i] % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result.join('');
}

// 按名称查找标签，不存在则创建，返回标签 ID（find-or-create）
async function findOrCreateTagId(name) {
  const res = await apiRequest('/api/tags', 'POST', { name });
  if (!res.ok) return null;
  return res.data?.id || null;
}

// API Client
async function apiRequest(endpoint, method = 'GET', body = null) {
  const config = await chrome.storage.local.get(['apiUrl', 'apiKey', 'masterPassword']);
  const apiUrl = cleanUrl(config.apiUrl);
  const apiKey = config.apiKey ? config.apiKey.trim() : '';

  if (!apiKey) {
    return { ok: false, error: '请先在插件中填写 API Key' };
  }

  const headers = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
  };

  if (config.masterPassword) {
    headers['X-Master-Password'] = config.masterPassword;
  }

  try {
    const res = await fetch(`${apiUrl}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = await res.json().catch(() => null);

    if (!res.ok) {
      const msg = json?.error?.message || json?.message || `请求失败 (${res.status})`;
      return { ok: false, error: msg, status: res.status };
    }

    return { ok: true, data: json?.data };
  } catch (err) {
    return { ok: false, error: `无法连接到服务: ${err.message}` };
  }
}

// Helper: Verify an address + key against the live API
// The TEST_CONNECTION and REDEEM_PAIR_TOKEN paths share this, so it's only written once
async function testConnectionTo(targetUrl, targetKey, targetMasterPassword) {
  if (!targetKey) return { ok: false, error: '请输入 API Key' };

  try {
    const headers = {
      'Content-Type': 'application/json',
      'X-API-Key': targetKey,
    };
    if (targetMasterPassword) headers['X-Master-Password'] = targetMasterPassword;

    const res = await fetch(`${targetUrl}/api/passwords?perPage=1`, {
      method: 'GET',
      headers,
    });

    const json = await res.json().catch(() => null);
    if (res.ok) return { ok: true, count: json?.data?.total ?? 0 };
    return { ok: false, error: json?.error?.message || `连接失败 (${res.status})` };
  } catch (err) {
    return { ok: false, error: `网络请求失败: ${err.message}` };
  }
}

// --- 截屏读取二维码 -------------------------------------------------------
// The QR code lives on the screen already, so there's no need to open the camera: grab the
// visible area of the tab with captureVisibleTab, let the user frame the code on top of that
// screenshot, and decode it. host_permissions is <all_urls>, so this permission is in place.

const SCAN_TAB_MEMORY_KEY = 'keyvaultScanTab';

/** The extension's own pages (popup / scanner / options) can't serve as a capture target */
function isExtensionPage(url) {
  return typeof url === 'string' && url.startsWith(chrome.runtime.getURL(''));
}

/** Chrome simply doesn't allow capturing these; better to tell the user up front than return a blank */
function isCaptureBlocked(url) {
  if (!url) return true;
  if (isExtensionPage(url)) return true;
  if (/^(chrome|devtools|edge|about|view-source|chrome-untrusted|chrome-search):/i.test(url)) return true;
  if (/^https?:\/\/([\w-]+\.)*chrome\.google\.com\/webstore/i.test(url)) return true;
  if (/^https?:\/\/chromewebstore\.google\.com/i.test(url)) return true;
  return false;
}

function captureErrorText(err) {
  const message = (err && err.message) || String(err || '');
  if (/cannot capture|activeTab/i.test(message)) {
    return '浏览器拒绝了截屏请求（Chrome 内部页面、扩展商店等不允许截图）';
  }
  if (/window is (minimized|not visible)/i.test(message)) {
    return '窗口处于最小化状态，浏览器不允许截屏，请把窗口显示出来再试';
  }
  return '截屏失败：' + (message || '未知错误');
}

async function rememberScanTab(tab) {
  const value = tab ? { tabId: tab.id, windowId: tab.windowId } : null;
  if (!chrome.storage.session) return;
  if (value) await chrome.storage.session.set({ [SCAN_TAB_MEMORY_KEY]: value }).catch(() => {});
  else await chrome.storage.session.remove(SCAN_TAB_MEMORY_KEY).catch(() => {});
}

async function takeRememberedScanTab() {
  if (!chrome.storage.session) return null;
  const stored = await chrome.storage.session.get([SCAN_TAB_MEMORY_KEY]).catch(() => ({}));
  const value = stored && stored[SCAN_TAB_MEMORY_KEY];
  return value && value.tabId ? value : null;
}

async function resolveCaptureTab(hint) {
  const fromHint = hint && hint.tabId ? await chrome.tabs.get(hint.tabId).catch(() => null) : null;
  if (fromHint && !isCaptureBlocked(fromHint.url)) return fromHint;

  const remembered = await takeRememberedScanTab();
  if (remembered) {
    const tab = await chrome.tabs.get(remembered.tabId).catch(() => null);
    if (tab && !isCaptureBlocked(tab.url)) return tab;
    await rememberScanTab(null);
  }

  // Last resort: the active tab of the most recently focused normal window. The popup
  // isn't a real window here, so this generally still points at the page under the cursor.
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  if (active && !isCaptureBlocked(active.url)) return active;

  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (win && win.id != null) {
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id }).catch(() => []);
    if (tab && !isCaptureBlocked(tab.url)) return tab;
  }

  return fromHint || active || null;
}

async function captureVisibleImage(tab) {
  if (!tab) return { ok: false, error: '找不到要截取的标签页' };
  if (isCaptureBlocked(tab.url)) {
    return {
      ok: false,
      error: '这个页面不允许截屏（Chrome 设置页、扩展商店等都不行），请在显示二维码的普通网页上使用',
    };
  }
  if (tab.windowId == null) return { ok: false, error: '找不到这个标签页所在的窗口' };

  // captureVisibleTab only grabs the active tab in that window. When the QR code lives on
  // a background tab, switch to it first, otherwise we'd screenshot the wrong page.
  if (!tab.active) {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    if (!dataUrl) return { ok: false, error: '浏览器返回了一张空截图' };
    return { ok: true, dataUrl };
  } catch (err) {
    return { ok: false, error: captureErrorText(err) };
  }
}

// Message Dispatcher
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = async () => {
    switch (message.type) {
      case 'GET_CONFIG': {
        const conf = await chrome.storage.local.get(['apiUrl', 'apiKey', 'masterPassword']);
        return {
          apiUrl: cleanUrl(conf.apiUrl),
          apiKey: conf.apiKey || '',
          hasMasterPassword: !!conf.masterPassword,
          isConfigured: !!(conf.apiKey && conf.apiKey.trim()),
        };
      }

      case 'OPEN_QR_SCANNER': {
        // The scanner page itself just shows the frame picker: it asks the background
        // for a screen capture, lets you frame the code, and decodes it with jsQR
        // (the desktop version of Chrome never implemented the native BarcodeDetector).
        // Remember the current tab now — once the scanner tab opens, it becomes the
        // "current" tab itself, and we can no longer tell which page to capture.
        const tab = await resolveCaptureTab(message.tabId ? { tabId: message.tabId } : null);
        await rememberScanTab(tab && !isCaptureBlocked(tab.url) ? tab : null);

        const params = new URLSearchParams();
        params.set('mode', message.mode === 'pair' ? 'pair' : 'fill');
        if (message.origin) params.set('origin', String(message.origin).slice(0, 200));
        await chrome.tabs.create({
          url: chrome.runtime.getURL(`scanner.html?${params.toString()}`),
          active: true,
        });
        return { ok: true };
      }

      // Called by the scanner page: hand over a screenshot of the page to capture
      case 'CAPTURE_ACTIVE_TAB': {
        const tab = await resolveCaptureTab(null);
        return await captureVisibleImage(tab);
      }

      // Called by the content script's inline button: grab the current tab's screen
      // directly, then push the screenshot back into that page for the frame picker
      case 'SCREEN_QR_CAPTURE': {
        const tabId = sender.tab && sender.tab.id;
        if (!tabId) return { ok: false, error: '无法确定要截取的标签页' };

        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const shot = await captureVisibleImage(tab);
        if (!shot.ok) return shot;

        const sent = await chrome.tabs
          .sendMessage(tabId, { type: 'SCREEN_QR_CAPTURE', dataUrl: shot.dataUrl })
          .catch(() => null);
        if (!sent || sent.ok !== true) {
          return { ok: false, error: '页面没接住截图（可能刚刚跳转了），请重试一次' };
        }
        return { ok: true };
      }

      // Same thing, but the screenshot is returned directly instead of pushed:
      // used when the frame picker is already open and wants to reshoot
      case 'CAPTURE_THIS_TAB': {
        const tabId = sender.tab && sender.tab.id;
        if (!tabId) return { ok: false, error: '无法确定要截取的标签页' };
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        return await captureVisibleImage(tab);
      }

      // Redeem a pairing code read from a QR code: swap it for an API Key, verify it
      // really works, write it to the extension config, and notify open pages
      case 'REDEEM_PAIR_TOKEN': {
        const token = String((message.payload && message.payload.token) || '').trim();
        if (!token) return { ok: false, error: '二维码里没有配对码' };

        const stored = await chrome.storage.local.get(['apiUrl']);
        // A full pairing link carries the address itself; a bare code falls back to
        // whatever the extension already has configured
        const rawBase = String((message.payload && message.payload.baseUrl) || stored.apiUrl || '').trim();
        if (!rawBase) {
          return { ok: false, error: '二维码里没带服务地址，请先在扩展里填写 API 服务地址，或改用完整配对链接' };
        }
        const baseUrl = cleanUrl(rawBase);

        let res;
        let body;
        try {
          res = await fetch(`${baseUrl}/api/pairing/redeem`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
          });
          body = await res.json().catch(() => null);
        } catch (err) {
          return { ok: false, error: `无法连接服务器：${err.message}` };
        }

        if (!res.ok || !body || body.success !== true) {
          return { ok: false, error: (body && body.error && body.error.message) || '配对失败，请回电脑端重新生成二维码' };
        }

        const apiUrl = cleanUrl(body.data.baseUrl || baseUrl);
        const apiKey = String(body.data.apiKey || '').trim();
        if (!apiKey) return { ok: false, error: '服务器返回的密钥为空，配对失败' };

        // Verify first, then write: a pairing code that hands out a bad key shouldn't
        // wipe out the config the user already had
        const check = await testConnectionTo(apiUrl, apiKey, '');
        if (!check.ok) return { ok: false, error: '密钥无效：' + (check.error || '连接测试失败') };

        await chrome.storage.local.set({ apiUrl, apiKey });
        chrome.runtime.sendMessage({ type: 'PAIR_CONNECTED', apiUrl }).catch(() => {});
        return { ok: true, apiUrl };
      }

      case 'SAVE_CONFIG': {
        const { apiUrl, apiKey, masterPassword } = message;
        await chrome.storage.local.set({
          apiUrl: cleanUrl(apiUrl),
          apiKey: (apiKey || '').trim(),
          masterPassword: (masterPassword || '').trim(),
        });
        return { ok: true };
      }

      case 'TEST_CONNECTION': {
        return await testConnectionTo(
          cleanUrl(message.apiUrl),
          (message.apiKey || '').trim(),
          (message.masterPassword || '').trim()
        );
      }

      case 'QUERY_CREDENTIALS': {
        const { hostname } = message;
        if (!hostname) return { ok: true, items: [] };

        const res = await apiRequest('/api/passwords?perPage=100');
        if (!res.ok) return res;

        const allItems = res.data?.items || [];
        const cleanHost = hostname.toLowerCase().replace(/^www\./, '');

        // Match site or url containing hostname or root domain
        const matched = allItems.filter((item) => {
          if (item.trashed) return false;
          const site = (item.site || '').toLowerCase();
          const url = (item.url || '').toLowerCase();
          return (
            site.includes(cleanHost) ||
            cleanHost.includes(site) ||
            url.includes(cleanHost) ||
            cleanHost.includes(url)
          );
        });

        return { ok: true, items: matched, total: allItems.length };
      }

      case 'LIST_ALL_PASSWORDS': {
        const query = message.search ? `&search=${encodeURIComponent(message.search)}` : '';
        return await apiRequest(`/api/passwords?perPage=200${query}`);
      }

      case 'LIST_TAGS': {
        return await apiRequest('/api/tags');
      }

      case 'SAVE_CREDENTIAL': {
        const { id, site, url, username, password, notes, tags: customTags } = message;
        if (!password) {
          return { ok: false, error: '密码不能为空' };
        }

        if (id) {
          return await apiRequest(`/api/passwords/${id}`, 'PUT', {
            site: site || new URL(url).hostname,
            url,
            username: username || '',
            password,
            notes: notes || '由密码保险库浏览器插件更新',
            tags: customTags || undefined,
          });
        }

        // 先确保「chrome-extension」标签存在，再以标签 ID 引用
        const tagId = await findOrCreateTagId('chrome-extension');
        const finalTags = Array.isArray(customTags) && customTags.length > 0
          ? (tagId && !customTags.includes(tagId) ? [...customTags, tagId] : customTags)
          : (tagId ? [tagId] : []);

        return await apiRequest('/api/passwords', 'POST', {
          site: site || new URL(url).hostname,
          url,
          username: username || '',
          password,
          notes: notes || '由密码保险库浏览器插件保存',
          tags: finalTags,
        });
      }

      case 'IGNORE_DOMAIN': {
        const { domain } = message;
        if (!domain) return { ok: false };
        const stored = await chrome.storage.local.get(['neverAskDomains']);
        const list = stored.neverAskDomains || [];
        if (!list.includes(domain)) {
          list.push(domain);
          await chrome.storage.local.set({ neverAskDomains: list });
        }
        return { ok: true };
      }

      case 'CHECK_DOMAIN_IGNORED': {
        const { domain } = message;
        if (!domain) return { ok: true, ignored: false };
        const stored = await chrome.storage.local.get(['neverAskDomains']);
        const list = stored.neverAskDomains || [];
        return { ok: true, ignored: list.includes(domain) };
      }

      case 'GENERATE_PASSWORD': {
        const password = generatePassword(message.options || {});
        return { ok: true, password };
      }

      default:
        return { ok: false, error: `未知消息类型: ${message.type}` };
    }
  };

  handler().then(sendResponse).catch((err) => {
    sendResponse({ ok: false, error: err.message });
  });

  return true; // Keep message channel open for async response
});
