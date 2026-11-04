// Only explicit user-owned OpenAI-compatible endpoints are available in this fork.
export const SELF_HOSTED_PROVIDER_ID = 'custom_openai';
export const SELF_HOSTED_DEFAULT = Object.freeze({
  type: 'openai', category: 'local', providerName: 'custom-openai',
  label: 'Custom OpenAI-compatible API', baseUrl: '', apiKey: '', model: '',
  configured: false, enabled: true, contextWindow: 65536,
  supportsAskStreaming: true, supportsStreamUsageOptions: true,
  supportsVision: false, inputCostPerMillionUsd: 0, outputCostPerMillionUsd: 0,
  shareQueriesForResearch: false,
});

export function ownEndpoint(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP(S) API URL without credentials, query parameters or a fragment.');
  }
  if (url.hostname.replace(/\.$/, '') === 'webbrain.one' || url.hostname.replace(/\.$/, '').endsWith('.webbrain.one')) {
    throw new Error('WebBrain cloud services are removed from this build.');
  }
  return url.href.replace(/\/+$/, '');
}

export function ownProvider(config = {}, id = SELF_HOSTED_PROVIDER_ID) {
  const value = { ...SELF_HOSTED_DEFAULT, ...config,
    type: 'openai', category: 'local', providerName: 'custom-openai',
    shareQueriesForResearch: false, helpImproveWebBrain: false,
  };
  if (value.baseUrl) value.baseUrl = ownEndpoint(value.baseUrl);
  for (const key of ['deviceGuid', 'siteUrl', 'apiKeyUrl', 'requiresApiKey', 'apiKeyHeader', 'sidepanelOnly']) delete value[key];
  if (id !== SELF_HOSTED_PROVIDER_ID) value.duplicateOf = SELF_HOSTED_PROVIDER_ID;
  else delete value.duplicateOf;
  return value;
}

export function selfHostedProviders(stored = {}, activeId = '') {
  const providers = { [SELF_HOSTED_PROVIDER_ID]: ownProvider() };
  for (const [id, config] of Object.entries(stored || {})) {
    if (id !== SELF_HOSTED_PROVIDER_ID && !/^custom_openai__duplicate(?:_\d+)?$/.test(id)) continue;
    try { providers[id] = ownProvider(config, id); } catch { /* A removed cloud configuration cannot be restored. */ }
  }
  // Carry over the selected local runtime, without bringing its provider-specific
  // cloud routing or credential metadata into the new generic API card.
  const selected = stored?.[activeId];
  if (!providers[activeId] && selected?.category === 'local'
      && ['openai', 'llamacpp'].includes(selected.type) && selected.baseUrl) {
    try { providers[SELF_HOSTED_PROVIDER_ID] = ownProvider({
      label: selected.label, baseUrl: selected.baseUrl.replace(/\/+$/, '').replace(/(?:\/v1)?$/, '/v1'),
      apiKey: selected.apiKey || '', model: selected.model || '', configured: true,
      contextWindow: selected.contextWindow || 65536, supportsVision: selected.supportsVision === true,
    }); } catch { /* Leave the empty API card for explicit setup. */ }
  }
  return { providers, activeProvider: providers[activeId] ? activeId : SELF_HOSTED_PROVIDER_ID };
}
