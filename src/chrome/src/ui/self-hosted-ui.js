// This build offers only explicit user-owned model endpoints.
const hide = selector => document.querySelectorAll(selector).forEach(node => {
  node.style.setProperty('display', 'none', 'important');
  node.setAttribute('aria-hidden', 'true');
});
hide('#profile-sync-card, #memcode-recall-card, #webgpu-vision-option, [data-tab="decision"], [data-panel="decision"], [data-tab="generative"], [data-panel="generative"], [data-tab="safesocial"], [data-panel="safesocial"], [data-tab="captcha"], [data-panel="captcha"]');
for (const id of ['toggle-help-improve', 'toggle-research-escalation', 'toggle-feedback-diagnostics', 'toggle-newtab']) {
  const input = document.getElementById(id);
  if (input) {
    input.checked = false; input.disabled = true;
    const row = input.closest('.setting-row, .setting-item') || input.parentElement?.parentElement;
    if (row) row.style.setProperty('display', 'none', 'important');
  }
}
const info = document.querySelector('[data-i18n-html="st.providers.info.html"]');
if (info) { info.removeAttribute('data-i18n-html'); info.textContent = 'Configure your OpenAI-compatible API Base URL, API key and model. Use Duplicate to add another endpoint.'; }

for (const id of ['vision-base-url', 'transcription-base-url']) {
  const input = document.getElementById(id); if (input) input.placeholder = 'http://127.0.0.1:8000/v1';
}
