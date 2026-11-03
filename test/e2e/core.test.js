import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHarness, inHerdr } from './harness.js';

const PROVIDERS = ['claude', 'codex', 'cursor'];

let h;
let taskFile;
const spawned = new Map();

before(() => {
  if (!inHerdr) return;
  h = createHarness('herd-e2e-core', { config: 'max_active = 4\n' });
  taskFile = h.task('ready', 'Reply in the conversation with the single word READY. Do not run commands or create any files other than your report.');
});

after(() => {
  if (inHerdr) h.cleanup();
});

test('doctor passes every check', { skip: !inHerdr }, () => {
  const result = h.herd('doctor');
  assert.equal(result.status, 0, result.text);
  assert.ok(result.out.checks.every((check) => check.status !== 'fail'));
});

test('pick returns a configured provider for each tier', { skip: !inHerdr }, () => {
  for (const tier of ['deep', 'standard', 'fast']) {
    const result = h.herd('pick', '--tier', tier);
    assert.equal(result.status, 0, result.text);
    assert.ok(PROVIDERS.includes(result.out.provider));
  }
});

test('spawns one agent per provider into the home tab grid', { skip: !inHerdr, timeout: 600000 }, () => {
  for (const provider of PROVIDERS) {
    const result = h.herd('spawn', '--tier', 'fast', '--task', taskFile, '--provider', provider, '--name', `e2e-${provider}`);
    assert.equal(result.status, 0, result.text);
    assert.equal(result.out.provider, provider);
    assert.equal(result.out.tab, h.tab);
    assert.equal(result.out.promptConfirmed, true);
    spawned.set(provider, result.out);
  }
  assert.equal(h.tabs().find((tab) => tab.tab_id === h.tab).pane_count, 4);
});

test('overflows into a herd-2 tab once the home tab holds 4 panes', { skip: !inHerdr, timeout: 300000 }, () => {
  const result = h.herd('spawn', '--tier', 'fast', '--task', taskFile, '--provider', 'claude', '--name', 'e2e-overflow');
  assert.equal(result.status, 0, result.text);
  h.own(result.out.tab);
  assert.notEqual(result.out.tab, h.tab);
  assert.equal(h.tabs().find((tab) => tab.tab_id === result.out.tab).label, 'herd-2');
  spawned.set('overflow', result.out);
});

test('queues a spawn beyond max_active', { skip: !inHerdr }, () => {
  const result = h.herd('spawn', '--tier', 'fast', '--task', taskFile, '--provider', 'claude', '--name', 'e2e-extra');
  assert.equal(result.status, 0, result.text);
  assert.equal(result.out.state, 'queued');
  assert.equal(result.out.position, 1);
  spawned.set('queued', result.out);
});

test('every started agent receives and answers its task', { skip: !inHerdr, timeout: 600000 }, async () => {
  for (const [key, agent] of spawned) {
    if (key !== 'queued') await h.waitForText(agent.id, 'READY');
  }
});

test('list reports every agent with its tab', { skip: !inHerdr }, () => {
  const result = h.herd('list');
  assert.equal(result.status, 0, result.text);
  assert.deepEqual(result.out.agents.map((agent) => agent.id).sort(), [...spawned.values()].map((agent) => agent.id).sort());
  const byId = new Map(result.out.agents.map((agent) => [agent.id, agent]));
  assert.equal(byId.get(spawned.get('queued').id).state, 'queued');
  assert.equal(byId.get(spawned.get('overflow').id).tab, 'herd-2');
  assert.ok(result.out.agents.every((agent) => agent.state !== 'gone'));
});

test('send delivers a follow-up prompt', { skip: !inHerdr, timeout: 300000 }, async () => {
  const { id } = spawned.get('claude');
  const result = h.herd('send', id, 'Reply in the conversation with the single word AGAIN.');
  assert.equal(result.status, 0, result.text);
  await h.waitForText(id, 'AGAIN');
});

test('close --all removes every pane, the overflow tab and the queued agent', { skip: !inHerdr }, () => {
  const result = h.herd('close', '--all');
  assert.equal(result.status, 0, result.text);
  assert.equal(result.out.closed.length, spawned.size);
  assert.deepEqual(result.out.tabsClosed, ['herd-2']);
  const live = h.tabs();
  assert.equal(live.find((tab) => tab.tab_id === h.tab).pane_count, 1);
  assert.ok(!live.some((tab) => tab.tab_id === spawned.get('overflow').tab));
  assert.equal(h.herd('list').out.agents.length, 0);
});
