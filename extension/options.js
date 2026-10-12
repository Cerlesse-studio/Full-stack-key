/**
 * KeyVault Chrome Extension - Options Page Logic
 */

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('options-form');
  const apiUrlInput = document.getElementById('apiUrl');
  const apiKeyInput = document.getElementById('apiKey');
  const masterPasswordInput = document.getElementById('masterPassword');
  const btnTest = document.getElementById('btn-test');
  const btnSave = document.getElementById('btn-save');
  const btnScan = document.getElementById('btn-scan');
  const feedback = document.getElementById('feedback');

  function showFeedback(msg, type = 'info') {
    feedback.textContent = msg;
    feedback.className = `feedback ${type}`;
    feedback.style.display = 'block';
  }

  // Load current configuration
  const config = await chrome.storage.local.get(['apiUrl', 'apiKey', 'masterPassword']);
  apiUrlInput.value = config.apiUrl || 'http://localhost:3000';
  apiKeyInput.value = config.apiKey || '';
  masterPasswordInput.value = config.masterPassword || '';

  // 截屏扫码配对：在新标签页里打开扫码器，它换到密钥后会广播 PAIR_CONNECTED
  btnScan.addEventListener('click', async () => {
    showFeedback('正在打开扫码器，截取屏幕后框住电脑端的二维码即可', 'info');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'OPEN_QR_SCANNER', mode: 'pair' });
      if (!res || res.ok === false) showFeedback(res?.error || '无法打开扫码器', 'error');
    } catch {
      showFeedback('无法打开扫码器', 'error');
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'PAIR_CONNECTED') return;
    (async () => {
      const conf = await chrome.runtime.sendMessage({ type: 'GET_CONFIG' }).catch(() => null);
      if (!conf || !conf.isConfigured) return;
      apiUrlInput.value = conf.apiUrl;
      apiKeyInput.value = conf.apiKey;
      showFeedback('扫码配对成功，地址与密钥已自动填好，点「保存配置」生效', 'success');
    })();
  });

  // Test connection
  btnTest.addEventListener('click', async () => {
    const apiUrl = apiUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    const masterPassword = masterPasswordInput.value.trim();

    if (!apiKey) {
      showFeedback('请输入 API Key 密钥后再测试', 'error');
      return;
    }

    btnTest.disabled = true;
    showFeedback('正在连接服务器并验证 API Key...', 'info');

    const res = await chrome.runtime.sendMessage({
      type: 'TEST_CONNECTION',
      apiUrl,
      apiKey,
      masterPassword,
    });

    btnTest.disabled = false;

    if (res && res.ok) {
      showFeedback(`✅ 连接成功！服务器响应正常（库中当前密码总数: ${res.count ?? 0} 条）`, 'success');
    } else {
      showFeedback(`❌ 连接失败: ${res?.error || '无法与后端服务建立通讯'}`, 'error');
    }
  });

  // Save configuration
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const apiUrl = apiUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    const masterPassword = masterPasswordInput.value.trim();

    if (!apiKey) {
      showFeedback('API Key 不能为空', 'error');
      return;
    }

    btnSave.disabled = true;
    showFeedback('正在验证并保存...', 'info');

    const testRes = await chrome.runtime.sendMessage({
      type: 'TEST_CONNECTION',
      apiUrl,
      apiKey,
      masterPassword,
    });

    if (!testRes || !testRes.ok) {
      showFeedback(`⚠️ 测试连接失败: ${testRes?.error || '请核对地址与密钥'}。若仍要强制保存请重试。`, 'error');
      btnSave.disabled = false;
      return;
    }

    await chrome.runtime.sendMessage({
      type: 'SAVE_CONFIG',
      apiUrl,
      apiKey,
      masterPassword,
    });

    btnSave.disabled = false;
    showFeedback('🎉 配置已成功保存！现在可以在任意网页上使用自动填入和密码保存功能了。', 'success');
  });
});
