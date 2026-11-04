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
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  if (body.stream) {
    response.setHeader('Content-Type', 'text/event-stream');
    for (const content of ['PRIVATE_', 'FIREFOX_OK']) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    }
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`);
    response.end('data: [DONE]\n\n');
    return;
  }
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
  await waitFor('document.documentElement.lang === "zh"', 'Chinese is the default interface language');
  assert.equal(await evaluate('document.querySelector(".btn-save[data-provider=custom_openai]").textContent.trim()'), '保存');
  assert.match(initial.providers.custom_openai.label, /自定义/);
  // A previous build may have cached English in both storage layers.
  await evaluate('(async () => { localStorage.setItem("wbLocale", "en"); await browser.storage.local.set({ wbLocale: "en", selfHostedChineseUiV1: false }); })()');
  await navigate('providers.html');
  await waitFor('document.documentElement.lang === "zh"', 'upgrade replaces the old automatic English default');
  await waitFor('browser.storage.local.get(["wbLocale", "selfHostedChineseUiV1"]).then(value => value.wbLocale === "zh" && value.selfHostedChineseUiV1 === true)', 'Chinese preference is persisted');
  // An explicit choice after that one-time migration remains available.
  await evaluate('import(browser.runtime.getURL("src/ui/i18n.js")).then(module => module.setLocale("en"))');
  await navigate('providers.html');
  await waitFor('document.documentElement.lang === "en"', 'a later manual language choice survives reload');
  await evaluate('import(browser.runtime.getURL("src/ui/i18n.js")).then(module => module.setLocale("zh"))');
  await waitFor('document.documentElement.dataset.settingsReady === "true"', 'provider settings remain ready after switching language');
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

  for (const action of ['translate', 'explain', 'proofread']) {
    const before = requests.length;
    const answer = await evaluate(`(async () => {
      const { wbLocale } = await browser.storage.local.get('wbLocale');
      return browser.runtime.sendMessage({ type: 'WB_SELECTION_SHORTCUT_INLINE', action: ${JSON.stringify(action)},
        selectionText: 'This short English passage is for the private selection test.', language: wbLocale });
    })()`);
    assert.equal(answer.ok, true, JSON.stringify(answer));
    const input = JSON.parse(requests.slice(before).find(request => request.path.endsWith('/chat/completions')).body);
    const prompt = input.messages.at(-1).content;
    assert.match(prompt, action === 'translate' ? /Translate this selected text into Chinese\./ : /Respond in Chinese\./);
    if (action === 'proofread') assert.match(prompt, /Keep the corrected passage in its original language/);
  }

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
  // Exercise the full conversation lifecycle, including its terminal journal.
  await evaluate(`(() => {
    globalThis.chatEvents = [];
    browser.runtime.onMessage.addListener(message => {
      if (message.action === 'agent_update') chatEvents.push(message);
    });
  })()`);
  try {
    for (const streaming of [true, false]) {
      await evaluate(`browser.storage.local.set({ openaiAskStreamingEnabled: ${streaming} })`);
      await evaluate(`(() => {
        chatEvents.length = 0;
        const input = document.getElementById('user-input');
        input.value = '/ask Say hello using only this message.';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('btn-send').click();
      })()`);
      await waitFor('chatEvents.some(event => event.type === "run_complete")', 'Ask turn finishes');
      await waitFor('document.getElementById("btn-send").dataset.i18nTitle === "sp.btn.send"', 'Ask follower settles');
      const conversation = await evaluate(`({
        events: chatEvents.map(({ type, data }) => ({ type, data })),
        errors: Array.from(document.querySelectorAll('.message.error'), node => node.textContent),
        answers: Array.from(document.querySelectorAll('.message.assistant .message-text'), node => node.textContent),
      })`);
      assert.deepEqual(conversation.errors, [], JSON.stringify(conversation));
      assert.equal(conversation.events.findLast(event => event.type === 'run_complete').data.status, 'completed', JSON.stringify(conversation));
      assert.equal(conversation.answers.length, streaming ? 1 : 2);
      assert.ok(conversation.answers.every(answer => answer === 'PRIVATE_FIREFOX_OK'), JSON.stringify(conversation));
      assert.equal(conversation.events.some(event => event.type === 'response_retry'), false);
      assert.equal(conversation.events.some(event => event.type === 'text_delta'), streaming);
    }
    // Older streaming entry points and Continue share the same memory bookkeeping.
    for (const action of ['chat_stream', 'continue']) {
      const result = await evaluate(`browser.runtime.sendMessage({ target: 'background', action: ${JSON.stringify(action)},
        tabId: chatEvents.find(event => event.tabId)?.tabId,
        requestId: 'private-firefox-${action}', mode: 'ask', text: 'Say hello using only this message.' })`);
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.equal(result.content, 'PRIVATE_FIREFOX_OK', JSON.stringify(result));
      const terminal = await evaluate('browser.runtime.sendMessage({ target: "background", action: "agent_run_state", tabId: chatEvents.find(event => event.tabId)?.tabId })');
      assert.equal(terminal.runUi.status, 'completed', JSON.stringify(terminal));
      assert.equal(terminal.runUi.runSucceeded, true);
    }
  } catch (error) {
    console.error('Conversation diagnostics:', await evaluate('({ events: chatEvents, text: document.body.innerText })'));
    throw error;
  }
  console.log(JSON.stringify({ browser: 'Firefox extension', providerSettings: 'passed', saveAndReload: 'passed',
    modelList: 'passed', ownAPIConnection: 'passed', duplicateEndpoint: 'passed', sidePanel: 'passed',
    chineseInterface: 'passed', localeMigration: 'passed', chineseSelectionActions: 'passed',
    askStreaming: 'passed', askNonStreaming: 'passed', legacyStreaming: 'passed', continuation: 'passed', version: manifest.version }));
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
