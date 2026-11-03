import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createHarness, inHerdr } from './harness.js';

const SIGNAL = 'HERD-SIMULATED-LIMIT';

let h;

before(() => {
  if (!inHerdr) return;
  h = createHarness('herd-e2e-failover', {
    config: `[adapters.claude]\nrate_limit_patterns = ["${SIGNAL}"]\n`,
    repoFiles: { 'README.md': '# failover\n' },
  });
});

after(() => {
  if (inHerdr) h.cleanup();
});

function usage() {
  return fs.readFileSync(path.join(h.herdHome, 'usage.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('manual failover restarts the task on another provider and keeps partial work', { skip: !inHerdr, timeout: 600000 }, () => {
  const spawn = h.herd('spawn', '--tier', 'fast', '--provider', 'claude', '--name', 'parts', '--write',
    '--task', h.task('parts', 'Make sure src/part1.txt contains exactly one and src/part2.txt contains exactly two, creating whichever is missing.'));
  assert.equal(spawn.status, 0, spawn.text);
  fs.mkdirSync(path.join(spawn.out.cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(spawn.out.cwd, 'src', 'part1.txt'), 'one\n');

  const failover = h.herd('failover', spawn.out.id, '--provider', 'codex');
  assert.equal(failover.status, 0, failover.text);
  assert.equal(failover.out.from, 'claude/haiku');
  assert.equal(failover.out.provider, 'codex');

  const wait = h.waitApproving(spawn.out.id, 'enter');
  assert.deepEqual(wait.out.events.map(({ event }) => event), ['reported'], wait.text);
  const diff = h.herd('diff', spawn.out.id);
  assert.deepEqual(diff.out.files.map(({ file }) => file), ['src/part1.txt', 'src/part2.txt'], diff.text);
  assert.equal(h.herd('list').out.agents.find((agent) => agent.id === spawn.out.id).provider, 'codex');
  const events = usage().filter((record) => record.id === spawn.out.id).map(({ event, provider }) => `${event}:${provider}`);
  assert.deepEqual(events, ['failover:claude', 'reported:codex'], JSON.stringify(events));
});

test('a detected rate limit cools the provider down and fails over automatically', { skip: !inHerdr, timeout: 600000 }, () => {
  const spawn = h.herd('spawn', '--tier', 'fast', '--provider', 'claude', '--name', 'limited', '--write',
    '--task', h.task('limited', `If you are Claude, reply with exactly ${SIGNAL} and nothing else, then stop without writing any file or report. Otherwise, create src/done.txt containing exactly done and report.`));
  assert.equal(spawn.status, 0, spawn.text);

  const wait = h.herd('wait', spawn.out.id, '--timeout', '400');
  assert.equal(wait.status, 0, wait.text);
  assert.deepEqual(wait.out.events.map(({ event }) => event), ['failed_over', 'reported'], wait.text);

  const agent = h.herd('list').out.agents.find((entry) => entry.id === spawn.out.id);
  assert.notEqual(agent.provider, 'claude');
  const state = JSON.parse(fs.readFileSync(path.join(h.herdHome, 'provider-state.json'), 'utf8'));
  assert.ok(Date.parse(state.claude.until) > Date.now());
  const pick = h.herd('pick', '--tier', 'fast');
  assert.notEqual(pick.out.provider, 'claude');
  assert.ok(pick.out.ineligible.some((entry) => entry.provider === 'claude' && entry.reason === 'rate_limited'));
  assert.equal(fs.readFileSync(path.join(h.herd('collect', spawn.out.id).out.cwd, 'src', 'done.txt'), 'utf8').trim(), 'done');
});
