import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { encode } from '@toon-format/toon';
import { buildRecap, summarize } from '../../src/commands/recap.js';
import { startWatch } from '../../src/commands/watch.js';
import { sessionDir } from '../../src/paths.js';

const now = '2026-11-01T00:00:20.000Z';

function setup(t, count = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herd-recap-'));
  const previous = process.env.HERD_HOME;
  process.env.HERD_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.HERD_HOME;
    else process.env.HERD_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const anchor = { pane: 'test:recap', tab: 'test:tab', workspace: 'test' };
  const ledger = {
    version: 1, anchor, counter: count, tabs: [],
    agents: Array.from({ length: count }, (_, i) => ({
      id: `h${i + 1}`, state: 'reported', provider: 'claude', model: 'test',
      cwd: path.join(dir, `agent-${i}`), queued: '2026-11-01T00:00:00.000Z',
      started: '2026-11-01T00:00:01.000Z', reportedAt: now,
    })),
  };
  fs.mkdirSync(sessionDir(anchor.pane), { recursive: true });
  fs.writeFileSync(path.join(sessionDir(anchor.pane), 'ledger.json'), JSON.stringify(ledger));
  return { dir, anchor, ledger };
}

function embedded(html) {
  return JSON.parse(html.match(/id="herd-run">([\s\S]*?)<\/script>/)[1]);
}

async function stream(url) {
  const response = await fetch(`${url}/events`, { signal: AbortSignal.timeout(5000) });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    cancel: () => reader.cancel(),
    async frame() {
      while (!buffer.includes('\n\n')) {
        const { value, done } = await reader.read();
        assert.equal(done, false, 'stream ended before a frame arrived');
        buffer += decoder.decode(value, { stream: true });
      }
      const end = buffer.indexOf('\n\n');
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      return frame;
    },
  };
}

test('recap builds a self-contained file from a transcript-free ledger and supports --out', async (t) => {
  const { dir, anchor } = setup(t);
  const project = path.join(dir, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  assert.equal(spawnSync('git', ['init', '--quiet', project]).status, 0);
  const result = await buildRecap({ anchor, cwd: path.join(project, 'src'), now });
  assert.equal(result.file, path.join(fs.realpathSync(project), '.herd', 'recaps', '2026-11-01T00-00-20-000Z.html'));
  assert.equal(spawnSync('git', ['-C', project, 'status', '--porcelain', '--untracked-files=all']).stdout.toString(), '');
  const html = fs.readFileSync(result.file, 'utf8');
  assert.match(html, /^<!doctype html>/i);
  assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:src|href)="(?!data:)/i);
  assert.equal(embedded(html).live, false);
  assert.equal(result.totals.agents, 2);
  assert.equal(result.totals.costUsd, null);
  assert.equal(result.totals.toolCalls, 0);
  assert.equal(result.totals.errors, 0);
  assert.deepEqual(result.quota, [{ provider: 'claude', usedPercent: null }]);
  assert.match(result.help[0], /browser/);
  const custom = path.join(dir, 'nested', 'custom.html');
  assert.equal((await buildRecap({ anchor, out: custom, now })).file, custom);
  assert.ok(fs.existsSync(custom));
  await assert.rejects(buildRecap({ anchor, out: path.join(custom, 'invalid.html'), now }), { code: 'recap_failed' });
});

test('summary bounds flags and clusters, ranks important entries and counts cluster agents', async (t) => {
  const { anchor } = setup(t, 200);
  const result = await buildRecap({ anchor, now });
  assert.ok(encode(result).length < 1500);
  const run = embedded(fs.readFileSync(result.file, 'utf8'));
  run.flags = Array.from({ length: 200 }, (_, i) => ({ severity: i === 199 ? 'error' : 'info', kind: 'test', agent: 'h1', message: 'x'.repeat(10000) }));
  run.errorClusters = Array.from({ length: 200 }, (_, i) => ({ count: i, agents: run.agents, signature: 'x'.repeat(10000) }));
  run.quota = [{ provider: 'claude', startPercent: 80, endPercent: 65 }];
  const bounded = summarize(run, result.file);
  assert.equal(bounded.flags.length, 5);
  assert.equal(bounded.flags[0].severity, 'error');
  assert.equal(bounded.errorClusters.length, 3);
  assert.equal(bounded.errorClusters[0].agents, 200);
  assert.equal(bounded.quota[0].usedPercent, 15);
  assert.ok(encode(bounded).length < 4000);
  assert.equal('agents' in bounded, false);
});

test('watch serves live HTML and an initial run event using the real telemetry builder', async (t) => {
  const { anchor } = setup(t);
  const dashboard = await startWatch({ anchor });
  try {
    assert.match(dashboard.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(dashboard.url);
    assert.equal(response.status, 200);
    const run = embedded(await response.text());
    assert.equal(run.live, true);
    assert.equal(run.totals.agents, 2);
    const events = await stream(dashboard.url);
    try {
      const frame = await events.frame();
      assert.match(frame, /^event: run\ndata: /);
      assert.deepEqual(JSON.parse(frame.slice('event: run\ndata: '.length)).totals, run.totals);
    } finally { await events.cancel(); }
    assert.equal((await fetch(`${dashboard.url}/missing`)).status, 404);
  } finally { await dashboard.close(); }
});

test('watch polls only with clients, broadcasts changes, pings, resumes and closes active streams', async (t) => {
  const { anchor } = setup(t);
  let calls = 0;
  let update = null;
  const initial = { version: 1, agents: [] };
  const dashboard = await startWatch({
    anchor, pollIntervalMs: 10, pingIntervalMs: 30,
    liveRun: { async refresh() { calls += 1; const next = calls === 1 ? initial : update; update = null; return next; } },
  });
  try {
    await delay(40);
    assert.equal(calls, 1);
    const first = await stream(dashboard.url);
    assert.match(await first.frame(), /event: run/);
    assert.equal(await first.frame(), ': ping');
    const second = await stream(dashboard.url);
    assert.match(await second.frame(), /event: run/);
    update = { ...initial, version: 2 };
    for (const events of [first, second]) {
      let frame;
      do { frame = await events.frame(); } while (frame.startsWith(':'));
      assert.equal(JSON.parse(frame.slice('event: run\ndata: '.length)).version, 2);
    }
    await first.cancel();
    await second.cancel();
    await delay(40);
    const idle = calls;
    await delay(40);
    assert.equal(calls, idle);
    const resumed = await stream(dashboard.url);
    assert.match(await resumed.frame(), /"version":2/);
    await delay(30);
    assert.ok(calls > idle + 1);
    await dashboard.close();
    await resumed.cancel();
    await assert.rejects(fetch(dashboard.url));
  } finally {
    if (dashboard.server.listening) await dashboard.close();
  }
});

test('watch rejects invalid and occupied ports with actionable errors', async (t) => {
  const { anchor } = setup(t);
  for (const port of ['-1', 'abc', '1.5', '65536', '']) {
    await assert.rejects(startWatch({ anchor, port }), { code: 'invalid_port', exitCode: 2 });
  }
  const dashboard = await startWatch({ anchor });
  try {
    await assert.rejects(startWatch({ anchor, port: dashboard.server.address().port }), { code: 'watch_listen_failed' });
  } finally { await dashboard.close(); }
});
