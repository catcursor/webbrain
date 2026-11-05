import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.browser = globalThis.chrome = { storage: { local: area, session: area },
  runtime: { getURL: path => path, sendMessage: async () => ({}) } };

function extract(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const background = await fs.readFile(new URL(`../src/${build}/src/background.js`, import.meta.url), 'utf8');
  const normalize = vm.runInNewContext(`(${extract(background, 'normalizeClarifyTimeoutSec')})`);

  test(`${build}: Off survives background-to-agent normalization`, () => {
    const agent = new Agent({});
    const off = normalize(1205);
    assert.equal(off, -1);
    assert.equal(normalize(off), -1);
    assert.equal(agent._normalizeClarifyTimeoutSec(off), -1);
    for (const value of [undefined, null, '', ' ', NaN, -1, 1205]) {
      assert.equal(normalize(value), -1);
      assert.equal(agent._normalizeClarifyTimeoutSec(value), -1);
    }
    for (const value of [0, 5, 60, 1200]) {
      assert.equal(normalize(value), value);
      assert.equal(agent._normalizeClarifyTimeoutSec(value), value);
    }
  });

  test(`${build}: upgrades disable automatic choices once and retain later manual settings`, async () => {
    for (const previous of [0, 60]) {
      const data = { clarifyTimeoutSec: previous, clarifyTimeoutSemanticsV2: true, clarifyTimeoutPolicy: 'safe' };
      const agent = { clarifyTimeoutSec: -1, clarifyTimeoutPolicy: 'finish' };
      const api = { storage: { local: {
        get: async () => ({ ...data }),
        set: async updates => { Object.assign(data, updates); },
      } } };
      const context = vm.createContext({ browser: api, chrome: api, agent,
        normalizeClarifyTimeoutSec: normalize, CLARIFY_TIMEOUT_OFF_SLIDER: 1205 });
      vm.runInContext(extract(background, 'loadClarifyTimeout'), context);
      await vm.runInContext('loadClarifyTimeout()', context);
      assert.equal(agent.clarifyTimeoutSec, -1);
      assert.equal(data.clarifyTimeoutSec, 1205);
      assert.equal(data.selfHostedManualChoicesV1, true);
      assert.equal(agent.clarifyTimeoutPolicy, 'safe');
      data.clarifyTimeoutSec = 0;
      await vm.runInContext('loadClarifyTimeout()', context);
      assert.equal(agent.clarifyTimeoutSec, 0, 'an explicit later choice is not reset on every startup');
    }
  });

  test(`${build}: an Act choice cannot advance until the user answers`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const agent = new Agent({});
    const tab = 46806;
    agent._runModeOverrides.set(tab, 'act');
    const updates = [];
    let notify, advanced = false;
    const ready = new Promise(resolve => { notify = resolve; });
    const pending = agent.executeTool(tab, 'clarify', {
      question: '请选择完成方式', options: ['方式 A', '方式 B'],
      consequence: 'none', finish_option: '方式 A',
    }, (type, data) => {
      updates.push({ type, data });
      if (type === 'clarify') notify(data);
    }).then(result => { advanced = true; return result; });
    try {
      const prompt = await ready;
      assert.equal(prompt.timeoutSec, 0, 'default choices must not start a countdown');
      assert.equal(prompt.timeoutAnswer, undefined);
      t.mock.timers.tick(24 * 60 * 60 * 1000);
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(advanced, false, 'elapsed time cannot choose a method');
      assert.equal(updates.some(update => update.type === 'clarify_auto'), false);
      assert.ok(agent._pendingClarifications.get(tab)?.has(prompt.clarifyId));
      assert.equal(agent.submitClarifyResponse(tab, prompt.clarifyId, '方式 B', 'option'), true);
      const result = await pending;
      assert.equal(result.answer, '方式 B');
      assert.equal(result.source, 'option');
      assert.equal(advanced, true);
      assert.equal(agent._pendingClarifications.has(tab), false);
      assert.equal(agent.submitClarifyResponse(tab, prompt.clarifyId, '方式 A', 'option'), false);
    } finally {
      agent._cancelClarifications(tab, 'Test cleanup');
      await pending;
    }
  });

  test(`${build}: an unanswered choice remains cancellable`, async () => {
    const agent = new Agent({});
    let notify;
    const ready = new Promise(resolve => { notify = resolve; });
    const pending = agent.executeTool(46807, 'clarify', {
      question: '请选择完成方式', options: ['方式 A', '方式 B'], consequence: 'none',
    }, (type, data) => { if (type === 'clarify') notify(data); });
    await ready;
    agent._cancelClarifications(46807, 'Stopped by user');
    assert.equal((await pending).cancelled, true);
  });
}
