// ============================================================
// settings.js — LLM settings modal (attaches to window.Anb.settings)
// ============================================================

window.Anb = window.Anb || {};

(function () {
  const DEFAULTS = {
    baseUrl: 'https://api.agnes-ai.cn/v1/chat/completions',
    apiKey: '',
    model: 'agnes-3.0-flash'
  };

  async function load() {
    let s = await window.Anb.storage.get('settings');
    if (s) {
      // One-time migration: if the stored values are still the untouched
      // defaults from the previous DeepSeek-era version (customised
      // settings — different URL / model / non-empty key — are left
      // alone), replace with the current defaults so the Settings
      // modal picks up the new provider without the user having to
      // wipe IndexedDB by hand.
      const OLD = {
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat'
      };
      if (
        s.baseUrl === OLD.baseUrl &&
        s.model === OLD.model &&
        (!s.apiKey || s.apiKey === '')
      ) {
        s = { baseUrl: DEFAULTS.baseUrl, apiKey: '', model: DEFAULTS.model };
        await save(s);
      }
      return { ...DEFAULTS, ...s };
    }
    return { ...DEFAULTS };
  }

  async function save(settings) {
    await window.Anb.storage.set('settings', settings);
  }

  function setupModal({ onSave } = {}) {
    const modal = document.getElementById('settings-modal');
    const form = document.getElementById('settings-form');
    const baseUrlInput = document.getElementById('cfg-base-url');
    const apiKeyInput = document.getElementById('cfg-api-key');
    const modelInput = document.getElementById('cfg-model');
    const cancelBtn = document.getElementById('cfg-cancel');
    const settingsBtn = document.getElementById('btn-settings');

    async function open() {
      const s = await load();
      baseUrlInput.value = s.baseUrl;
      apiKeyInput.value = s.apiKey;
      modelInput.value = s.model;
      modal.classList.remove('hidden');
      setTimeout(() => baseUrlInput.focus(), 50);
    }

    function close() {
      modal.classList.add('hidden');
    }

    settingsBtn.addEventListener('click', open);
    cancelBtn.addEventListener('click', close);

    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
        close();
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const settings = {
        baseUrl: baseUrlInput.value.trim(),
        apiKey: apiKeyInput.value.trim(),
        model: modelInput.value.trim()
      };
      await save(settings);
      if (typeof onSave === 'function') onSave(settings);
      close();
    });

    return { open, close };
  }

  window.Anb.settings = { load, save, setupModal };
})();
