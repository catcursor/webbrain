import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';

function storage(seed = {}) {
  const data = structuredClone(seed);
  let writes = 0;
  return { data, get writes() { return writes; },
    async get(keys) {
      if (keys == null) return structuredClone(data);
      const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(names.map(key => [key, data[key] === undefined && !Array.isArray(keys) && typeof keys === 'object' ? keys[key] : structuredClone(data[key])]));
    },
    async set(values) { Object.assign(data, structuredClone(values)); writes++; },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  };
}
function setChrome(area) {
  globalThis.chrome = { storage: { local: area, onChanged: { addListener() {} } }, runtime: {} };
  globalThis.browser = globalThis.chrome;
}

for (const browser of ['chrome', 'firefox']) {
  await import(`../src/${browser}/src/ui/provider-icons.js`);
  const { ProviderManager } = await import(`../src/${browser}/src/providers/manager.js`);
  const { ownEndpoint, selfHostedProviders } = await import(`../src/${browser}/src/providers/self-hosted.js`);
  const { OpenAICompatibleProvider } = await import(`../src/${browser}/src/providers/openai.js`);
  const memory = await import(`../src/${browser}/src/agent/user-memory.js`);
  const share = await import(`../src/${browser}/src/trace/webbrain-share-outbox.js`);
  const cloud = await import(`../src/${browser}/src/trace/cloud-runtime-outbox.js`);
  const { resolveDecisionConfig } = await import(`../src/${browser}/src/agent/decision-config.js`);
  const { installChatLinkIcons } = await import(`../src/${browser}/src/ui/chat-link-icons.js`);
  const { ProfileSyncManager } = await import(`../src/${browser}/src/profile-sync.js`);
  const { DEFAULT_SKILL_SOURCES, PACKAGED_SKILL_SOURCES, removeRetiredPackagedSkills } = await import(`../src/${browser}/src/agent/skills.js`);

  test(`${browser}: fresh install has one empty API card, no hosted fallback or repeat migration writes`, async () => {
    const area = storage(); setChrome(area);
    const manager = new ProviderManager(); await manager.load();
    assert.deepEqual(Object.keys(manager.getAll()), ['custom_openai']);
    assert.equal(manager.activeProviderId, 'custom_openai');
    assert.equal(manager.getActive().config.baseUrl, '');
    assert.equal(manager.getProvider('webbrain_cloud'), null);
    assert.equal(area.data.helpImproveWebBrain, false);
    assert.equal(area.data.userMemoryAutoCaptureEnabled, false);
    assert.equal(area.data.feedbackDiagnosticsEnabled, false);
    assert.equal(area.data.screenshotRedaction, true);
    await assert.rejects(manager.getActive().chat([{ role: 'user', content: 'private' }]), /Configure your own/);
    const writes = area.writes; await manager.load(); assert.equal(area.writes, writes);
  });

  test(`${browser}: stale cloud cards and research consent cannot return through import or update`, async () => {
    const area = storage({ providers: {
      webbrain_cloud: { type: 'openai', baseUrl: 'https://api.webbrain.one/v1' },
      openai: { type: 'openai', baseUrl: 'https://api.openai.com/v1', configured: true },
      custom_openai: { baseUrl: 'https://own.example.org/api/v1', configured: true, model: 'mine', shareQueriesForResearch: true },
    }, activeProvider: 'openai', webbrainShareOutboxV1: ['private'], wb_user_memory_extraction_queue_v1: ['private'] });
    setChrome(area); const manager = new ProviderManager(); await manager.load();
    assert.deepEqual(Object.keys(manager.getAll()), ['custom_openai']);
    assert.equal(manager.getActive().config.shareQueriesForResearch, false);
    assert.equal(area.data.webbrainShareOutboxV1, undefined);
    assert.equal(area.data.wb_user_memory_extraction_queue_v1, undefined);
    await manager.updateProvider('custom_openai', { shareQueriesForResearch: true, providerName: 'webbrain-cloud' });
    assert.equal(manager.getActive().config.shareQueriesForResearch, false);
    assert.equal(manager.getActive().config.providerName, 'custom-openai');
    assert.equal(manager.consentedShareProviderIds().size, 0);
    assert.throws(() => ownEndpoint('https://api.webbrain.one/v1'), /removed/);
    assert.throws(() => ownEndpoint('https://key:secret@own.example.org/v1'), /credentials/);
    assert.equal(ownEndpoint('http://192.168.1.8:8000/v1/'), 'http://192.168.1.8:8000/v1');
    const migrated = selfHostedProviders({ vllm: { category: 'local', type: 'openai', baseUrl: 'http://192.168.1.8:8000/v1', model: 'mine' } }, 'vllm');
    assert.equal(migrated.providers.custom_openai.baseUrl, 'http://192.168.1.8:8000/v1');
    assert.equal(migrated.providers.custom_openai.model, 'mine');
  });

  test(`${browser}: model list and conversation reach only the configured API, duplicates preserve it`, async () => {
    const requests = [];
    const server = http.createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      requests.push({ url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.url.endsWith('/models')
        ? { data: [{ id: 'private-model' }] }
        : { choices: [{ message: { role: 'assistant', content: 'local response' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const area = storage(); setChrome(area);
      const manager = new ProviderManager(); await manager.load();
      const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
      await manager.updateProvider('custom_openai', { baseUrl: endpoint, model: 'private-model', apiKey: 'fixture-key', supportsVision: true });
      const listing = await manager.listProviderModels('custom_openai');
      assert.equal(listing.ok, true); assert.ok(listing.models.includes('private-model'));
      const result = await manager.getActive().chat([{ role: 'user', content: 'private marker' }], { maxTokens: 20 });
      assert.equal(result.content, 'local response');
      const chat = requests.find(request => request.url === '/v1/chat/completions'); assert.ok(chat);
      assert.equal(chat.headers.authorization, 'Bearer fixture-key');
      assert.equal(chat.headers['x-webbrain-device-id'], undefined);
      assert.equal(chat.headers['x-webbrain-help-improve'], undefined);
      assert.equal(JSON.parse(chat.body).model, 'private-model');
      assert.ok(chat.body.includes('private marker'));
      const duplicate = await manager.duplicateProvider('custom_openai');
      await manager.updateProvider(duplicate.providerId, { baseUrl: endpoint, model: 'second-model' });
      await manager.load();
      assert.equal(manager.providers.size, 2);
      assert.ok([...manager.providers.values()].every(provider => provider.config.baseUrl === endpoint));
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  test(`${browser}: research, sync, icons, secondary cloud decisions and default external skills are disabled`, async () => {
    let network = 0; const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { network++; throw new Error('unexpected external request'); };
    try {
      assert.equal(share.buildShareGenerationItem({ messages: ['private'] }), null);
      await share.enqueueShareGeneration({ private: true }); await share.flushShareOutbox({});
      await cloud.enqueueCloudRuntimeEvent('private', {}); await cloud.flushCloudRuntimeOutbox({});
      const provider = new OpenAICompatibleProvider({ providerName: 'webbrain-cloud', baseUrl: 'https://api.webbrain.one/v1' });
      await provider.sendShareGeneration('private', {}); await provider.sendShareDiagnostic('private', {}); await provider.sendRuntimeEvents('private', []);
      await assert.rejects(new ProfileSyncManager(storage()).request('/vault'), /removed/);
      const config = resolveDecisionConfig({ decisionMode: 'on', decisionProvider: 'openrouter', systemOneEnabled: true });
      assert.equal(config.enabled, false);
      installChatLinkIcons({ querySelectorAll() { return [{ href: 'https://private.example.org' }]; } })();
      assert.equal(network, 0);
      assert.ok(!DEFAULT_SKILL_SOURCES.some(skill => skill.id === 'freeskillz-xyz'));
      assert.ok(!PACKAGED_SKILL_SOURCES.some(skill => skill.id === 'freeskillz-xyz'));
      assert.equal(removeRetiredPackagedSkills([{ id: 'freeskillz-xyz', sourceType: 'built-in', sourceUrl: 'skills/freeskillz-xyz.md' }]).length, 0);
    } finally { globalThis.fetch = originalFetch; }
  });

  test(`${browser}: model POST refuses redirects instead of forwarding private text`, async () => {
    let destinationRequests = 0;
    const destination = http.createServer((request, response) => { destinationRequests++; response.end('{}'); });
    await new Promise(resolve => destination.listen(0, '127.0.0.1', resolve));
    const redirector = http.createServer((request, response) => {
      response.writeHead(307, { Location: `http://127.0.0.1:${destination.address().port}/capture` }); response.end();
    });
    await new Promise(resolve => redirector.listen(0, '127.0.0.1', resolve));
    try {
      setChrome(storage());
      const provider = new OpenAICompatibleProvider({ baseUrl: `http://127.0.0.1:${redirector.address().port}/v1`, model: 'mine', category: 'local' });
      await assert.rejects(provider.chat([{ role: 'user', content: 'PRIVATE_REDIRECT_MARKER' }]));
      assert.equal(destinationRequests, 0);
    } finally {
      await new Promise(resolve => redirector.close(resolve)); await new Promise(resolve => destination.close(resolve));
    }
  });

  test(`${browser}: pending memory uses its original provider, drops changed endpoints/models and unbound legacy jobs`, async () => {
    const source = fs.readFileSync(`src/${browser}/src/background.js`, 'utf8');
    const enqueue = source.slice(source.indexOf('async function enqueueUserMemoryExtraction(payload'), source.indexOf('function enqueueUserMemoryExtractionAfterTurn'));
    const drain = source.slice(source.indexOf('async function drainUserMemoryExtractionQueue()'), source.indexOf('async function loadPackagedSkillRecords('));
    const queue = [], sends = [];
    const original = { name: 'own-a', config: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'A' } };
    const other = { name: 'own-b', config: { baseUrl: 'https://other.example.org/v1', model: 'B' } };
    const manager = { providers: new Map([['a', original], ['b', other]]), activeProviderId: 'a' };
    const context = vm.createContext({ ...memory, console, USER_MEMORY_EXTRACTION_RETRY_DELAY_MS: 30000,
      userMemoryExtractionDrainPromise: null,
      isUserMemoryExtractionEnabled: async () => true, isUserMemoryFormCaptureEnabled: async () => true,
      updateUserMemoryExtractionQueue: async fn => fn(queue), scheduleUserMemoryExtractionDrain() {},
      peekUserMemoryExtractionJob: async () => queue[0] || null, removeUserMemoryExtractionJob: async () => queue.shift(),
      customSkillsReady: Promise.resolve(), userMemoryStore: { load: async () => ({ records: [] }) }, providerManager: manager,
      agent: { _newCostRunState: () => ({}), _chatWithCostAllowance: async (provider, messages) => {
        sends.push({ provider: provider.name, body: messages[1].content }); return { content: '{"memories":[]}' };
      } },
      applyUserMemoryExtractionOperationsToCurrentStore: async () => { queue.shift(); return { changed: false }; },
      markUserMemoryExtractionJobFailed: async () => { throw new Error('unexpected retry'); },
      syncAgentUserMemoryFromStorage: async () => {}, notifyUserMemoryCreated() {},
    });
    vm.runInContext(enqueue + '\n' + drain, context);
    const add = () => vm.runInContext('enqueueUserMemoryExtraction({providerId:"a",userText:"LOCAL_PRIVATE_MARKER",assistantText:"private reply"})', context);
    await add(); manager.activeProviderId = 'b';
    await vm.runInContext('drainUserMemoryExtractionQueue()', context);
    assert.equal(sends.length, 1); assert.equal(sends[0].provider, 'own-a');
    assert.ok(sends[0].body.includes('LOCAL_PRIVATE_MARKER'));
    await add(); original.config.baseUrl = 'https://changed.example.org/v1';
    await vm.runInContext('drainUserMemoryExtractionQueue()', context); assert.equal(sends.length, 1);
    const dropped = await vm.runInContext('enqueueUserMemoryExtraction({providerId:"a",providerBaseUrl:"http://original.invalid/v1",providerModel:"A",userText:"private",assistantText:"reply"})', context);
    assert.equal(dropped.reason, 'provider_changed');
    await add(); original.config.model = 'changed';
    await vm.runInContext('drainUserMemoryExtractionQueue()', context); assert.equal(sends.length, 1);
    queue.push({ userText: 'legacy private', assistantText: 'legacy reply' });
    await vm.runInContext('drainUserMemoryExtractionQueue()', context); assert.equal(sends.length, 1); assert.equal(queue.length, 0);
  });
}

test('Chrome: transcription never auto-selects a saved cloud API or uploads a video container', async () => {
  const { transcribeAudio } = await import('../src/chrome/src/agent/transcribe.js');
  setChrome(storage());
  const originalFetch = globalThis.fetch; let network = 0;
  globalThis.fetch = async () => { network++; throw new Error('unexpected request'); };
  try {
    const cloudProviders = new Map([['openai', { config: { baseUrl: 'https://api.openai.com/v1', apiKey: 'fixture' } }]]);
    const noOverride = await transcribeAudio(cloudProviders, new Blob(['audio'], { type: 'audio/webm' }));
    assert.equal(noOverride.ok, false); assert.match(noOverride.error, /own transcription endpoint/);
    const video = await transcribeAudio(cloudProviders, new Blob(['video'], { type: 'video/webm' }));
    assert.equal(video.ok, false); assert.match(video.error, /Video recordings/); assert.equal(network, 0);
  } finally { globalThis.fetch = originalFetch; }
});
