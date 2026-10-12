/**
 * 离线校验后台新增的消息处理（截屏 + 配对兑换）。
 *
 * 真的加载 extension/background.js，只把 chrome.* 换成可控的假实现，
 * fetch 换成可控的假服务器（外加一个打到本地 3000 的真实请求）。
 *
 *   node test-pages/verify-background.mjs
 */
import { readFileSync } from 'node:fs';

let failed = 0;
const ok = (cond, label, extra) => {
  if (cond) {
    console.log(`✓ ${label}`);
  } else {
    failed += 1;
    console.error(`✗ ${label}${extra ? ` — ${JSON.stringify(extra)}` : ''}`);
  }
};

/** 装一套假的 chrome，再把 background.js 跑起来，返回一个发消息的入口 */
function bootBackground({ storage = {}, tabs = [], windows = [] } = {}) {
  const listeners = [];
  const broadcasts = [];
  const local = { ...storage };
  const session = {};

  globalThis.chrome = {
    runtime: {
      id: 'fake',
      getURL: (path) => `chrome-extension://fake/${path}`,
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: (msg) => {
        broadcasts.push(msg);
        return Promise.resolve();
      },
    },
    contextMenus: { create: () => {}, onClicked: { addListener: () => {} } },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const key of Array.isArray(keys) ? keys : Object.keys(local)) {
            if (key in local) out[key] = local[key];
          }
          return out;
        },
        set: async (items) => Object.assign(local, items),
        remove: async (key) => delete local[key],
      },
      session: {
        get: async (keys) => {
          const out = {};
          for (const key of Array.isArray(keys) ? keys : Object.keys(session)) {
            if (key in session) out[key] = session[key];
          }
          return out;
        },
        set: async (items) => Object.assign(session, items),
        remove: async (key) => delete session[key],
      },
    },
    tabs: {
      get: async (id) => {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) throw new Error('No tab with id');
        return tab;
      },
      query: async (query) => {
        let list = tabs;
        if (query.active) list = list.filter((t) => t.active);
        if (query.windowId != null) list = list.filter((t) => t.windowId === query.windowId);
        return list;
      },
      update: async () => {},
      create: async () => {},
      sendMessage: async () => ({ ok: true }),
      captureVisibleTab: async (windowId, options) => {
        if (windowId === 42) throw new Error('Cannot capture a tab');
        return `data:image/png;base64,SHOT#${windowId}#${options.format}`;
      },
    },
    windows: {
      getLastFocused: async () => (windows[0] ? { id: windows[0] } : Promise.reject(new Error('no window'))),
    },
  };

  new Function(readFileSync('extension/background.js', 'utf8'))();

  return {
    local,
    session,
    broadcasts,
    send: (message, sender = {}) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('后台没有回话')), 5000);
        for (const listener of listeners) {
          const keep = listener(message, sender, (response) => {
            clearTimeout(timer);
            resolve(response);
          });
          if (keep === true) return;
        }
      }),
  };
}

// --- 1. 截屏：目标页面不允许截屏时要给出可执行的提示 --------------------

{
  const bg = bootBackground({
    tabs: [
      { id: 1, url: 'https://vault.example.com/', windowId: 7, active: true },
      { id: 2, url: 'chrome://settings/', windowId: 7, active: false },
    ],
  });
  const blocked = await bg.send({ type: 'SCREEN_QR_CAPTURE' }, { tab: { id: 2, windowId: 7 } });
  ok(blocked.ok === false && /不允许截屏/.test(blocked.error), 'chrome:// 页面给出明确提示', blocked);

  const good = await bg.send({ type: 'SCREEN_QR_CAPTURE' }, { tab: { id: 1, windowId: 7 } });
  ok(good.ok === true, '普通网页可以截屏并把截图推回页面', good);

  const noTab = await bg.send({ type: 'SCREEN_QR_CAPTURE' }, {});
  ok(noTab.ok === false, '没有来源标签页时报错而不是崩', noTab);
}

// --- 2. 扩展自己的页面不能被当成截图目标 --------------------------------

{
  const bg = bootBackground({
    tabs: [{ id: 9, url: 'chrome-extension://fake/scanner.html', windowId: 7, active: true }],
  });
  const res = await bg.send({ type: 'CAPTURE_ACTIVE_TAB' });
  ok(res.ok === false && /不允许截屏/.test(res.error), '扫码页自己不会被当成截图目标', res);
}

// --- 3. 兑换成功：写配置 + 广播，且先验后写 ---------------------------

{
  const bg = bootBackground();
  const originalFetch = globalThis.fetch;
  let listCall = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/pairing/redeem')) {
      return new Response(
        JSON.stringify({ success: true, data: { apiKey: 'kv_live_key', baseUrl: 'http://localhost:3000' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (String(url).includes('/api/passwords')) {
      listCall += 1;
      return new Response(JSON.stringify({ success: true, data: { total: 2 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`不该发起的请求: ${url}`);
  };

  const res = await bg.send({
    type: 'REDEEM_PAIR_TOKEN',
    payload: { token: 'Kq7bZ2mXpL9vTn4Rc', baseUrl: 'http://localhost:3000' },
  });
  ok(res.ok === true && res.apiUrl === 'http://localhost:3000', '兑换成功后返回服务地址', res);
  ok(bg.local.apiKey === 'kv_live_key' && bg.local.apiUrl === 'http://localhost:3000', '配置已写入', bg.local);
  ok(listCall === 1, '写配置前先验证过密钥', { listCall });
  ok(
    bg.broadcasts.some((m) => m.type === 'PAIR_CONNECTED'),
    '已广播 PAIR_CONNECTED',
    bg.broadcasts
  );

  globalThis.fetch = originalFetch;
}

// --- 4. 密钥无效时不能覆盖用户原有配置 --------------------------------

{
  const bg = bootBackground({ storage: { apiUrl: 'http://localhost:3000', apiKey: 'kv_old_good_key' } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/pairing/redeem')) {
      return new Response(
        JSON.stringify({ success: true, data: { apiKey: 'kv_bad_key', baseUrl: 'http://localhost:3000' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ error: { message: 'API Key 无效' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  };

  const res = await bg.send({
    type: 'REDEEM_PAIR_TOKEN',
    payload: { token: 'Kq7bZ2mXpL9vTn4Rc', baseUrl: 'http://localhost:3000' },
  });
  ok(res.ok === false && /密钥无效/.test(res.error), '无效密钥被拦下', res);
  ok(bg.local.apiKey === 'kv_old_good_key', '无效密钥不会覆盖原有配置', bg.local);
  ok(!bg.broadcasts.some((m) => m.type === 'PAIR_CONNECTED'), '失败时不广播', bg.broadcasts);

  globalThis.fetch = originalFetch;
}

// --- 5. 二维码里没带地址时的两种退路 ---------------------------------

{
  const bg = bootBackground({ storage: { apiUrl: 'https://vault.example.com' } });
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes('/api/pairing/redeem')) {
      return new Response(JSON.stringify({ success: false, error: { message: '配对码无效或已过期' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('不该发起的请求');
  };

  // 裸配对码：退回用扩展里已配置的地址
  const res = await bg.send({ type: 'REDEEM_PAIR_TOKEN', payload: { token: 'Kq7bZ2mXpL9vTn4Rc', baseUrl: '' } });
  ok(res.ok === false && /过期/.test(res.error), '服务端错误原样透出', res);
  ok(seen[0] === 'https://vault.example.com/api/pairing/redeem', '裸配对码退回用已配置地址', seen);

  // 什么都没配：明确告诉用户去填地址
  const empty = bootBackground();
  const res2 = await empty.send({ type: 'REDEEM_PAIR_TOKEN', payload: { token: 'Kq7bZ2mXpL9vTn4Rc', baseUrl: '' } });
  ok(res2.ok === false && /服务地址/.test(res2.error), '没有地址也没有配置时报错清楚', res2);
  ok(Object.keys(empty.local).length === 0, '报错时不动配置', empty.local);

  globalThis.fetch = originalFetch;
}

// --- 6. 打开扫码页前要先记住“该截哪一页” -----------------------------
// 扫码页自己是个新标签页，一旦打开它就成了活动页，再也分不清该截谁。
{
  const created = [];
  const bg = bootBackground({
    tabs: [
      { id: 3, url: 'http://localhost:3000/dashboard/settings', windowId: 7, active: true },
      { id: 4, url: 'chrome://extensions/', windowId: 7, active: false },
    ],
  });
  const originalCreate = globalThis.chrome.tabs.create;
  globalThis.chrome.tabs.create = async (opts) => created.push(opts.url);

  const res = await bg.send({ type: 'OPEN_QR_SCANNER', mode: 'pair' });
  ok(res.ok === true && created.length === 1 && /scanner\.html\?mode=pair/.test(created[0]), '打开的是扫码页', created);

  // 之后扫码页来要截图时，用的还是先前记住的那个标签页
  const shot = await bg.send({ type: 'CAPTURE_ACTIVE_TAB' });
  ok(shot.ok === true && String(shot.dataUrl).includes('#7'), '记住的标签页被用来截图', shot.dataUrl && String(shot.dataUrl).slice(0, 40));

  globalThis.chrome.tabs.create = originalCreate;
}

// --- 7. TEST_CONNECTION 没被改坏（尽量打真实的本地服务） -------------

let serverUp = true;
try {
  await fetch('http://localhost:3000/api/passwords?perPage=1', {
    headers: { 'X-API-Key': 'probe' },
    signal: AbortSignal.timeout(2000),
  });
} catch {
  serverUp = false;
}

if (!serverUp) {
  console.log('· 本地 3000 没在跑（npm run dev），跳过真实接口的两条断言');
} else {
  const bg = bootBackground();
  const res = await bg.send({
    type: 'TEST_CONNECTION',
    apiUrl: 'http://localhost:3000',
    apiKey: 'definitely-not-a-real-key',
    masterPassword: '',
  });
  ok(res.ok === false && typeof res.error === 'string' && res.error.length > 0, '错误密钥能拿到服务端错误信息', res);

  const empty = await bg.send({ type: 'TEST_CONNECTION', apiUrl: 'http://localhost:3000', apiKey: '' });
  ok(empty.ok === false && /API Key/.test(empty.error), '空密钥直接被拦', empty);
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);