import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BidiSession } from '../firefox-companion/session.mjs';

const { firefox } = createRequire(import.meta.url)('playwright');
const extension = path.resolve('src/firefox');
const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-private-firefox-'));
const uuid = 'd8772bba-3185-4ada-95fb-c030e2d9fd81';
await fs.writeFile(path.join(profile, 'user.js'),
  `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [manifest.browser_specific_settings.gecko.id]: uuid }))});\n`);

const requests = [];
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requests.push({ path: request.url, body: Buffer.concat(chunks).toString(), authorization: request.headers.authorization });
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', '*');
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'OPTIONS') { response.end(); return; }
  response.end(JSON.stringify(request.url.endsWith('/models')
    ? { data: [{ id: 'private-firefox-model' }] }
    : { choices: [{ message: { role: 'assistant', content: 'PRIVATE_FIREFOX_OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
const processHandle = spawn(process.env.FIREFOX_BINARY || firefox.executablePath(),
  ['--headless', '--remote-allow-system-access', '--no-remote', '--profile', profile, '--remote-debugging-port', '0'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
let session;
let output = '';
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Firefox did not start BiDi: ${output.slice(-1500)}`)), 30000);
    const receive = data => {
      output += data;
      const match = output.match(/WebDriver BiDi listening on ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    processHandle.stdout.on('data', receive);
    processHandle.stderr.on('data', receive);
    processHandle.once('error', error => { clearTimeout(timer); reject(error); });
    processHandle.once('exit', code => { clearTimeout(timer); reject(new Error(`Firefox exited (${code}): ${output.slice(-1500)}`)); });
  });
  session = new BidiSession();
  await session.connect(port);
  await session.send('webExtension.install', { extensionData: { type: 'path', path: extension } });
  const tree = await session.send('browsingContext.getTree', {});
  const context = tree.contexts[0]?.context;
  assert.ok(context, 'Firefox has a tab for the settings test');
  const origin = `moz-extension://${uuid}`;
  const evaluate = async expression => {
    const result = await session.send('script.evaluate', { target: { context }, awaitPromise: true,
      expression: `Promise.resolve(${expression}).then(value => JSON.stringify(value ?? null))` });
    if (result.type === 'exception') throw new Error(result.exceptionDetails.text);
    return JSON.parse(result.result.value);
  };
  const waitFor = async (expression, label) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${label}`);
  };
  const navigate = page => session.send('browsingContext.navigate', { context, url: `${origin}/src/ui/${page}`, wait: 'complete' });
  await navigate('providers.html');
  await waitFor('document.documentElement.dataset.settingsReady === "true"', 'Firefox provider settings initialize');
  const initial = await evaluate('browser.runtime.sendMessage({ target: "background", action: "get_providers" })');
  assert.deepEqual(Object.keys(initial.providers), ['custom_openai']);
  assert.equal(await evaluate('document.getElementById("subtitle").textContent.includes(browser.runtime.getManifest().version)'), true);
  assert.equal(await evaluate('!!document.querySelector("input[data-provider=custom_openai][data-key=baseUrl]")'), true);

  // Save using the actual rendered fields and button, then verify persistence.
  await evaluate(`(() => {
    for (const [key, value] of Object.entries(${JSON.stringify({ baseUrl: endpoint, apiKey: 'fixture-firefox-key', model: 'private-firefox-model' })})) {
      const input = document.querySelector('input[data-provider="custom_openai"][data-key="' + key + '"]');
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelector('.btn-save[data-provider="custom_openai"]').click();
  })()`);
  await waitFor('browser.storage.local.get("providers").then(data => data.providers?.custom_openai?.configured === true)', 'API settings are saved');
  await navigate('providers.html');
  await waitFor('document.documentElement.dataset.settingsReady === "true"', 'saved API settings reload');
  assert.equal(await evaluate('document.querySelector("input[data-provider=custom_openai][data-key=baseUrl]").value'), endpoint);

  await evaluate('document.querySelector(".btn-load-models[data-provider=custom_openai]").click()');
  await waitFor('Array.from(document.querySelectorAll("#models-custom_openai option")).some(option => option.value === "private-firefox-model")', 'model list loads from the owned API');
  await evaluate('(() => { document.getElementById("test-custom_openai").className = "test-result"; document.querySelector(".btn-test[data-provider=custom_openai]").click(); })()');
  await waitFor('document.getElementById("test-custom_openai").classList.contains("ok")', 'API connection test succeeds');
  const chat = requests.find(request => request.path === '/v1/chat/completions');
  assert.ok(chat, 'Firefox reaches the configured chat API');
  assert.equal(chat.authorization, 'Bearer fixture-firefox-key');
  assert.equal(JSON.parse(chat.body).model, 'private-firefox-model');

  // The existing duplicate control is the way to add another own endpoint.
  assert.equal(await evaluate('document.querySelector(".btn-duplicate[data-provider=custom_openai]").disabled'), false);
  await evaluate('document.querySelector(".btn-duplicate[data-provider=custom_openai]").click()');
  await waitFor('document.querySelectorAll("input[data-key=baseUrl][data-provider^=custom_openai]").length === 2', 'another endpoint card can be added');

  await navigate('sidepanel.html');
  await waitFor('document.getElementById("provider-select")?.value === "custom_openai"', 'side panel selects the saved API');
  const state = await evaluate('browser.storage.local.get(["activeProvider", "helpImproveWebBrain", "userMemoryAutoCaptureEnabled", "selfHostedPrivacyV1"])');
  assert.equal(state.activeProvider, 'custom_openai');
  assert.equal(state.helpImproveWebBrain, false);
  assert.equal(state.userMemoryAutoCaptureEnabled, false);
  assert.equal(state.selfHostedPrivacyV1, true);
  console.log(JSON.stringify({ browser: 'Firefox extension', providerSettings: 'passed', saveAndReload: 'passed',
    modelList: 'passed', ownAPIConnection: 'passed', duplicateEndpoint: 'passed', sidePanel: 'passed', version: manifest.version }));
} finally {
  await session?.close();
  if (processHandle.exitCode === null) {
    const stopped = new Promise(resolve => processHandle.once('exit', resolve));
    processHandle.kill();
    let timer;
    await Promise.race([stopped, new Promise(resolve => { timer = setTimeout(() => { processHandle.kill('SIGKILL'); resolve(); }, 5000); })]);
    clearTimeout(timer);
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true });
}
