import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webbrain-private-browser-'));
const extension = path.resolve('src/chrome');
const requests = [];
const server = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  requests.push({ path: request.url, body: Buffer.concat(chunks).toString() });
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', '*');
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'OPTIONS') { response.end(); return; }
  response.end(JSON.stringify(request.url.endsWith('/models') ? { data: [{ id: 'private-browser-model' }] }
    : { choices: [{ message: { role: 'assistant', content: 'PRIVATE_BROWSER_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
let context;
try {
  const executablePath = process.env.WEBBRAIN_CHROME_PATH || chromium.executablePath();
  context = await chromium.launchPersistentContext(profile, { executablePath, channel: 'chromium', headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-sandbox', '--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const extensionOrigin = `chrome-extension://${new URL(worker.url()).hostname}`;
  const failures = [];
  const external = [];
  context.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(`http://127.0.0.1:${server.address().port}/`)) external.push(request.url()); });
  const page = await context.newPage();
  page.on('pageerror', error => { failures.push(error.message); console.error('Extension page error:', error.message); });
  page.on('console', message => { if (message.type() === 'error') console.error('Extension console:', message.text()); });
  await page.goto(`${extensionOrigin}/src/ui/providers.html`);
  await page.waitForSelector('input[data-provider="custom_openai"][data-key="baseUrl"]', { state: 'attached', timeout: 20000 }).catch(async error => {
    console.error('Providers DOM:', await page.locator('#providers').innerHTML());
    console.error('Background state:', await page.evaluate(() => chrome.runtime.sendMessage({ target: 'background', action: 'get_providers' })));
    throw error;
  });
  assert.equal(await page.locator('.provider-card[data-provider="webbrain_cloud"]').count(), 0);
  const response = await page.evaluate(async ({ endpoint }) => {
    const send = (action, values = {}) => chrome.runtime.sendMessage({ target: 'background', action, ...values });
    const before = await send('get_providers');
    const update = await send('update_provider', { providerId: 'custom_openai', config: { baseUrl: endpoint, model: 'private-browser-model', apiKey: 'fixture-browser-key' } });
    const listing = await send('list_provider_models', { providerId: 'custom_openai' });
    const test = await send('test_provider', { providerId: 'custom_openai' });
    return { before, update, listing, test };
  }, { endpoint });
  assert.deepEqual(Object.keys(response.before.providers), ['custom_openai']);
  assert.equal(response.listing.ok, true, JSON.stringify(response));
  assert.equal(response.test.ok, true, JSON.stringify(response));
  assert.ok(requests.some(request => request.path === '/v1/chat/completions'));
  await page.reload();
  await page.waitForSelector('input[data-provider="custom_openai"][data-key="baseUrl"]');
  assert.equal(await page.locator('input[data-provider="custom_openai"][data-key="baseUrl"]').inputValue(), endpoint);
  await page.goto(`${extensionOrigin}/src/ui/sidepanel.html`);
  await page.waitForSelector('#user-input');
  await page.waitForFunction(() => document.getElementById('provider-select')?.value === 'custom_openai');
  assert.equal(await page.locator('#provider-select option[value="webbrain_cloud"]').count(), 0);
  const state = await page.evaluate(() => chrome.storage.local.get(['activeProvider', 'helpImproveWebBrain', 'userMemoryAutoCaptureEnabled']));
  assert.equal(state.activeProvider, 'custom_openai');
  assert.equal(state.helpImproveWebBrain, false);
  assert.equal(state.userMemoryAutoCaptureEnabled, false);
  assert.deepEqual(failures, []);
  assert.deepEqual(external, []);
  console.log(JSON.stringify({ browser: 'Chromium extension', providerSettings: 'passed', modelList: 'passed', ownAPIConnection: 'passed', sidePanel: 'passed', unexpectedNetworkRequests: external.length }));
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(profile, { recursive: true, force: true });
}
