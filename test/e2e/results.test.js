import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createHarness, herdr, inHerdr } from './harness.js';

let h;
const agents = {};

before(() => {
  if (!inHerdr) return;
  h = createHarness('herd-e2e-results', { config: 'max_active = 1\n', repoFiles: { 'README.md': '# results\n' } });
});

after(() => {
  if (inHerdr) h.cleanup();
});

function readIn(cwd, name) {
  return fs.readFileSync(path.join(cwd, name), 'utf8').trim();
}

test('a second spawn queues while max_active is 1', { skip: !inHerdr, timeout: 300000 }, () => {
  const alpha = h.herd('spawn', '--tier', 'fast', '--provider', 'claude', '--name', 'alpha', '--write',
    '--task', h.task('alpha', 'Create a file named alpha.txt in the working directory containing exactly the text alpha. Do not run shell commands.'));
  assert.equal(alpha.status, 0, alpha.text);
  assert.equal(alpha.out.state, 'running');
  assert.equal(alpha.out.mode, 'write');
  agents.alpha = alpha.out.id;

  const beta = h.herd('spawn', '--tier', 'fast', '--provider', 'codex', '--name', 'beta', '--write',
    '--task', h.task('beta', 'Create a file named beta.txt in the working directory containing exactly the text beta. Do not run shell commands.'));
  assert.equal(beta.status, 0, beta.text);
  assert.equal(beta.out.state, 'queued');
  agents.beta = beta.out.id;
});

test('wait --all starts the queued agent and returns once both report done', { skip: !inHerdr, timeout: 600000 }, () => {
  const result = h.herd('wait', '--all', '--timeout', '540');
  assert.equal(result.status, 0, result.text);
  const reported = result.out.events.filter((event) => event.event === 'reported');
  assert.deepEqual(reported.map((event) => event.id).sort(), [agents.alpha, agents.beta].sort(), result.text);
  assert.ok(reported.every((event) => event.detail === 'done'), result.text);
});

test('collect returns validated reports and archives them', { skip: !inHerdr }, () => {
  for (const [name, id] of Object.entries(agents)) {
    const result = h.herd('collect', id);
    assert.equal(result.status, 0, result.text);
    assert.equal(result.out.status, 'done');
    assert.ok(result.out.files_changed.some((file) => file.endsWith(`${name}.txt`)), result.text);
    assert.ok(fs.existsSync(result.out.archived));
    assert.equal(readIn(result.out.cwd, `${name}.txt`), name);
  }
});

test('wait with nothing open returns immediately', { skip: !inHerdr }, () => {
  const result = h.herd('wait', '--timeout', '30');
  assert.equal(result.status, 0, result.text);
  assert.deepEqual(result.out.events, []);
});

test('a needs_input report round-trips through send, approving blocked commands with keys', { skip: !inHerdr, timeout: 900000 }, () => {
  const spawn = h.herd('spawn', '--tier', 'fast', '--provider', 'cursor', '--name', 'color', '--write',
    '--task', h.task('color', [
      'You need the user to choose a color before doing anything else.',
      'First, write your report with status "needs_input" and the question "Which color should I use?", then stop.',
      'After you receive the answer, write the chosen color as the only content of color.txt in the working directory and report done.',
    ].join(' ')));
  assert.equal(spawn.status, 0, spawn.text);
  const id = spawn.out.id;

  const first = h.waitApproving(id);
  assert.deepEqual(first.out.events.map(({ event, detail }) => ({ event, detail })), [{ event: 'reported', detail: 'needs_input' }], first.text);
  const question = h.herd('collect', id);
  assert.equal(question.out.status, 'needs_input');
  assert.ok(question.out.questions.length >= 1);

  const send = h.herd('send', id, 'Use blue.');
  assert.equal(send.status, 0, send.text);
  assert.equal(send.out.round, 2);

  const second = h.waitApproving(id);
  assert.deepEqual(second.out.events.map(({ event, detail }) => ({ event, detail })), [{ event: 'reported', detail: 'done' }], second.text);
  const done = h.herd('collect', id);
  assert.equal(done.out.status, 'done');
  assert.equal(readIn(done.out.cwd, 'color.txt').toLowerCase(), 'blue');
});

test('wait reports an agent whose pane disappears before it reports', { skip: !inHerdr, timeout: 300000 }, () => {
  const spawn = h.herd('spawn', '--tier', 'fast', '--provider', 'claude', '--name', 'vanish',
    '--task', h.task('vanish', 'Count slowly from 1 to 50 in the conversation, one number per line, then write your report.'));
  assert.equal(spawn.status, 0, spawn.text);
  herdr('pane', 'close', spawn.out.pane);
  const result = h.herd('wait', spawn.out.id, '--timeout', '60');
  assert.equal(result.status, 0, result.text);
  assert.deepEqual(result.out.events.map(({ event }) => event), ['exited'], result.text);
  assert.equal(h.herd('list', '--all').out.agents.find((agent) => agent.id === spawn.out.id).state, 'failed');
});
