import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { analyzeShell, splitCommands, classifyCommand, errorSignature, filePath, hasErrorOutput, primaryCategory } from '../../src/telemetry/shell.js';
import { parseClaude, toolEvent, resultEvent } from '../../src/telemetry/claude.js';
import { parseCodex } from '../../src/telemetry/codex.js';
import { parseCursor } from '../../src/telemetry/cursor.js';
import { createAgent, foldEvent, foldRun, snapshotAgent } from '../../src/telemetry/fold.js';
import { createLocator, locateAgent } from '../../src/telemetry/locate.js';
import { buildRun, createLiveRun } from '../../src/telemetry/run.js';
import { DEFAULT_CONFIG, repoSettings, loadConfig } from '../../src/config.js';

const fixtures = fileURLToPath(new URL('../fixtures/transcripts/', import.meta.url));
const start = '2026-11-01T00:00:00.000Z', end = '2026-11-01T00:00:20.000Z';
const entry = (id = 'h1-task', provider = 'claude') => ({ id, task: '# Synthetic task', queued: start, started: start, reportedAt: end, state: 'reported', provider, model: 'test-model', worktree: 'C:/work', cwd: 'C:/work', repo: 'C:/repo', mode: 'write', scope: ['src/**'], round: 1 });
const fixture = (provider) => path.join(fixtures, `${provider}.jsonl`);
function reduce(agent, events, options = {}) {
  const acc = createAgent(agent, [{ provider: agent.provider, model: agent.model, transcript: 'fixture', started: start, ended: end }]);
  for (const event of events) foldEvent(acc, event, options);
  return acc;
}

test('shell splits quoted chains and PowerShell while stripping the worktree cd', () => {
  assert.deepEqual(splitCommands('cd "C:\\work"; npm test && cat "a;b.ts" | head -n 2; node -e "x(); y()"', { worktree: 'C:/work' }), ['npm test', 'cat "a;b.ts"', 'head -n 2', 'node -e "x(); y()"']);
  assert.deepEqual(splitCommands('cd /other && npm test', { worktree: '/work' }), ['cd /other', 'npm test']);
  assert.equal(classifyCommand('custom verify', { verify: ['custom verify'] }), 'test');
  assert.equal(classifyCommand('npm run check', { commands: { '^npm run check': 'test', '[': 'read' } }), 'test');
  for (const [command, category] of [['npx remotion render Demo out.mp4', 'render'], ['npm ci', 'install'], ['git status', 'git'], ['npm run build', 'build'], ['Get-Content src/a.ts', 'read'], ['Set-Content src/a.ts x', 'edit'], ['python task.py', 'script'], ['Remove-Item out.mp4', 'cleanup']]) assert.equal(classifyCommand(command), category);
  assert.deepEqual(analyzeShell('cat src/a.ts > out/a.txt')[0], { command: 'cat src/a.ts > out/a.txt', category: 'read', read: ['src/a.ts'], written: ['out/a.txt'] });
  assert.equal(filePath('c:\\WORK\\src\\a.ts', 'C:/work'), 'src/a.ts');
  assert.equal(filePath('/external/a.ts', '/work'), null);
  assert.equal(filePath('a.ts', '/work', '/work/src'), 'src/a.ts');
  assert.deepEqual(analyzeShell('node -e "fs.writeFileSync(\'src/a.ts\', data)"')[0].written, ['src/a.ts']);
});

test('error signatures normalize changing paths, numbers and addresses and prefer final Python exceptions', () => {
  assert.equal(errorSignature('Error: C:\\work\\src\\a.ts:42 failed at 0xABC'), errorSignature('Error: D:\\other\\b.ts:99 failed at 0xDEF'));
  assert.equal(errorSignature('Traceback (most recent call last):\n  File "/tmp/a.py", line 17\n    fail()\nValueError: invalid value 42'), 'ValueError: invalid value <n>');
});

test('Claude pairs background completions, deduplicates usage and attributes saved reads', async () => {
  const result = await parseClaude(fixture('claude'), { worktree: 'C:/work' });
  const ends = result.events.filter((e) => e.type === 'tool_end' && e.id === 'bg');
  assert.equal(ends.length, 1); assert.equal(ends[0].at, '2026-11-01T00:00:10.000Z');
  assert.equal(result.events.filter((e) => e.type === 'prompt').length, 1);
  assert.equal(result.events.filter((e) => e.type === 'context').length, 3);
  assert.equal(result.events.filter((e) => e.type === 'usage').reduce((n, e) => n + e.tokens.input, 0), 500);
  const saved = result.events.find((e) => e.type === 'tool_start' && e.id === 'saved-read');
  assert.equal(saved.label, 'Bash:read cat src/a.ts'); assert.deepEqual(saved.files.read, []);
  const agent = snapshotAgent(reduce(entry(), result.events), { now: end });
  assert.deepEqual(agent.tokens, { input: 500, output: 30, cacheRead: 20, cacheWrite: 10, exact: true });
  assert.equal(agent.cost.usd, 0.25); assert.equal(agent.cost.exact, true);
  assert.equal(agent.time.background, 9); assert.equal(agent.time.idle, 9);
  assert.equal(agent.context.series[2].cause, 'Bash:read cat src/a.ts');
});

test('Codex pairs mixed batch exits and polled jobs and extracts patches without executing JS', async () => {
  const result = await parseCodex(fixture('codex'), { worktree: 'C:/work' });
  const calls = result.events.filter((e) => e.type === 'tool_start');
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[3].files.written, ['src/a.ts']);
  const ends = result.events.filter((e) => e.type === 'tool_end');
  assert.equal(ends.filter((e) => e.error).length, 1);
  assert.equal(ends.find((e) => e.id === 'batch:1').at, '2026-11-01T00:00:05.000Z');
  assert.deepEqual(result.state.jobs, {});
  const acc = reduce(entry('h1-task', 'codex'), result.events, { prices: { 'test-model': { input: 2, cached_input: 1, output: 10 } } });
  const agent = snapshotAgent(acc, { now: end });
  assert.equal(agent.cost.usd, 0.0021); assert.equal(agent.cost.exact, false);
  assert.equal(agent.tokens.input, 600); assert.equal(agent.tokens.cacheRead, 400);
  assert.equal(agent.context.series.length, 1); assert.equal(agent.time.background, 4);
  assert.equal(snapshotAgent(reduce(entry('h1-task', 'codex'), result.events)).cost.usd, null);
});

test('byte offsets leave a partial UTF-8 last line for the next tail without replay', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herd-tail-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tail.jsonl');
  const first = JSON.stringify({ type: 'user', timestamp: start, message: { content: 'brief é' } }) + '\n';
  const second = JSON.stringify({ type: 'user', timestamp: end, message: { content: 'follow-up 🐑' } }) + '\n';
  const bytes = Buffer.from(second), cut = bytes.indexOf(Buffer.from('🐑')) + 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from(first), bytes.subarray(0, cut)]));
  const initial = await parseClaude(file); assert.equal(initial.offset, Buffer.byteLength(first)); assert.equal(initial.events.length, 1);
  fs.appendFileSync(file, bytes.subarray(cut));
  const tail = await parseClaude(file, initial); assert.equal(tail.events.length, 1); assert.equal(tail.offset, fs.statSync(file).size);
  assert.equal((await parseClaude(file, tail)).events.length, 0);
});

test('two-agent fold reports shared failures and writes and keeps Cursor uncertainty', async () => {
  const curs = await parseCursor(fixture('cursor'), { worktree: 'C:/work' });
  const c = snapshotAgent(reduce(entry('h3', 'cursor'), curs.events));
  assert.equal(c.tokens.exact, false); assert.equal(c.cost.usd, null); assert.deepEqual(c.context.series, []);
  assert.ok(c.timeline.every((v) => !['tool', 'background'].includes(v.kind)));
  const events = [
    { type: 'tool_start', id: 'edit', name: 'Write', at: start, label: 'Write src/a.ts', shell: [], files: { read: [], written: ['src/a.ts'] } },
    { type: 'tool_end', id: 'edit', at: '2026-11-01T00:00:01.000Z', error: false },
    { type: 'tool_start', id: 'test', name: 'Bash', at: '2026-11-01T00:00:02.000Z', label: 'npm test', shell: [{ category: 'test' }], files: { read: [], written: [] } },
    { type: 'tool_end', id: 'test', at: '2026-11-01T00:00:03.000Z', error: true, signature: 'Error: shared failure', family: 'command' },
  ];
  const ledger = { anchor: { pane: 'w:p1' }, agents: [entry('h1'), entry('h2')] };
  const run = foldRun({ anchor: ledger.anchor, ledger, accumulators: ledger.agents.map((a) => reduce(a, events)), now: end });
  assert.equal(run.totals.errors, 2); assert.equal(run.errorClusters[0].count, 2);
  assert.ok(run.flags.some((f) => f.kind === 'overlapping_writes'));
  assert.ok(run.flags.some((f) => f.kind === 'shared_error'));
  assert.equal(run.files[0].agents.h2.writes, 1);
});

test('fold flags repeated errors, churn, compactions, blocked permissions and idle time', () => {
  const e = { ...entry(), state: 'blocked', reportedAt: undefined, turnStarted: '2026-11-01T00:00:15.000Z' }, acc = createAgent(e);
  for (let i = 0; i < 5; i += 1) foldEvent(acc, { type: 'file', path: 'src/a.ts', operation: 'written', at: start });
  for (let i = 0; i < 3; i += 1) {
    foldEvent(acc, { type: 'tool_start', id: `${i}`, name: 'Bash', at: start, label: 'test', shell: [{ category: 'test' }], files: { read: [], written: [] } });
    foldEvent(acc, { type: 'tool_end', id: `${i}`, at: '2026-11-01T00:00:01.000Z', error: true, denied: true, family: 'permission', signature: `Permission denied for operation ${i}` });
  }
  foldEvent(acc, { type: 'context', at: start, id: 'first', size: 10000, output: 100, window: 100000 });
  foldEvent(acc, { type: 'context', at: '2026-11-01T00:00:02.000Z', id: 'second', size: 90000, output: 100, window: 100000 });
  foldEvent(acc, { type: 'compaction', at: '2026-11-01T00:00:03.000Z' });
  foldEvent(acc, { type: 'turn_end', at: '2026-11-01T00:00:03.000Z' });
  const run = foldRun({ anchor: 'test:p1', ledger: { agents: [e] }, accumulators: [acc], live: true, now: end, config: { idle_nudge_seconds: 5 } });
  for (const kind of ['fix_loop', 'edit_churn', 'context_growth', 'compaction', 'permission_block', 'idle']) assert.ok(run.flags.some((f) => f.kind === kind), kind);
  assert.equal(run.agents[0].time.blocked, 5); assert.equal(run.agents[0].activity.kind, 'blocked');
});

test('locator retries incomplete first lines and keeps identical slugs separate by recorded cwd', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herd-header-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, '.codex/sessions/2026/11/01/rollout-partial.jsonl'), cache = new Map(), agent = entry('h1', 'codex');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{"type":"session_meta"');
  assert.equal((await createLocator([agent], { home, now: end, cache })).candidates.length, 0);
  fs.appendFileSync(file, ',"timestamp":"2026-11-01T00:00:00.000Z","payload":{"cwd":"C:/work"}}\n');
  assert.equal((await createLocator([agent], { home, now: end, cache })).candidates.length, 1);
  const other = { ...agent, provider: 'claude', cwd: 'C:/work/a.b', worktree: 'C:/work/a.b' }, right = { ...agent, provider: 'claude', cwd: 'C:/work/a-b', worktree: 'C:/work/a-b' };
  const claude = path.join(home, '.claude/projects/C--work-a-b/transcript.jsonl'); fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.writeFileSync(claude, JSON.stringify({ type: 'user', timestamp: start, cwd: right.cwd }) + '\n');
  const locator = await createLocator([other, right], { home, now: end });
  assert.equal((await locateAgent(other, { locator, now: end }))[0].transcript, null);
  assert.equal((await locateAgent(right, { locator, now: end }))[0].transcript, claude);
});

test('locator stitches failover by cwd and date and build/live preserve incremental totals', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herd-locate-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const previous = process.env.HERD_HOME; process.env.HERD_HOME = path.join(home, '.herd');
  t.after(() => { if (previous === undefined) delete process.env.HERD_HOME; else process.env.HERD_HOME = previous; });
  const claude = path.join(home, '.claude/projects/C--work/first.jsonl'), codex = path.join(home, '.codex/sessions/2026/11/01/rollout-test.jsonl');
  fs.mkdirSync(path.dirname(claude), { recursive: true }); fs.mkdirSync(path.dirname(codex), { recursive: true });
  fs.copyFileSync(fixture('claude'), claude); fs.copyFileSync(fixture('codex'), codex);
  const e = { ...entry('h1', 'codex'), failovers: [{ from: 'claude/sonnet', at: '2026-11-01T00:00:00.000Z' }] };
  const located = await locateAgent(e, { home, now: end }); assert.equal(located.length, 2); assert.equal(located[1].transcript, codex);
  const liveEntry = { ...entry(), state: 'running', reportedAt: undefined };
  const ledger = { anchor: { pane: 'test:p1' }, agents: [liveEntry] }, file = path.join(home, '.herd/sessions/test-p1/ledger.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(ledger));
  const recap = await buildRun({ ledger, config: DEFAULT_CONFIG, home, now: end }); assert.equal(recap.agents[0].cost.usd, 0.25);
  const live = createLiveRun({ anchor: ledger.anchor, config: DEFAULT_CONFIG, home });
  const initial = await live.refresh({ now: end }); assert.equal(initial.live, true); assert.ok(initial.agents[0].activity);
  assert.equal(await live.refresh({ now: end }), null);
  fs.appendFileSync(claude, JSON.stringify({ type: 'user', timestamp: '2026-11-01T00:00:21.000Z', message: { content: 'Follow-up' } }) + '\n');
  const update = await live.refresh({ now: '2026-11-01T00:00:22.000Z' });
  assert.equal(update.agents[0].prompts.length, 2); assert.equal(update.totals.toolCalls, initial.totals.toolCalls);
  ledger.agents[0].state = 'reported'; ledger.agents[0].reportedAt = '2026-11-01T00:00:22.000Z'; fs.writeFileSync(file, JSON.stringify(ledger));
  assert.equal((await live.refresh({ now: '2026-11-01T00:00:23.000Z' })).agents[0].prompts.length, 2);
  assert.equal(await live.refresh({ now: '2026-11-01T00:00:24.000Z' }), null);
  assert.equal(fs.existsSync(path.join(path.dirname(file), 'ledger.lock')), false);
  assert.deepEqual((await createLocator([{ ...e, cwd: 'D:/other' }], { home, now: end })).candidates, []);
});

test('config merges empty prices and repository command defaults', (t) => {
  assert.deepEqual(DEFAULT_CONFIG.prices, {}); assert.deepEqual(repoSettings(DEFAULT_CONFIG, 'C:/repo').commands, {});
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herd-config-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const previous = process.env.HERD_HOME; process.env.HERD_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.HERD_HOME; else process.env.HERD_HOME = previous; });
  fs.writeFileSync(path.join(home, 'config.toml'), '[prices.test]\ninput = 1\ncached_input = 0.5\noutput = 2\n[repos."C:/repo".commands]\n"^custom" = "test"\n');
  const config = loadConfig(); assert.equal(config.prices.test.input, 1); assert.equal(repoSettings(config, 'C:/repo').commands['^custom'], 'test');
});

test('successful provider results detect soft errors and cluster distinct agents before frequency', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herd-soft-errors-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = "Traceback (most recent call last):\n  File \"task.py\", line 1\n    read()\n"
    + "UnicodeDecodeError: 'charmap' codec can't decode byte 0x8f";
  const claude = path.join(dir, 'claude.jsonl');
  const codex = path.join(dir, 'codex.jsonl');
  const lines = [
    { type: 'assistant', timestamp: start, message: { content: [
      { type: 'tool_use', id: 'soft', name: 'Bash', input: { command: 'python task.py; echo done' } },
    ] } },
    { type: 'user', timestamp: end, message: { content: [
      { type: 'tool_result', tool_use_id: 'soft', is_error: false, content: output },
    ] }, toolUseResult: { exitCode: 0 } },
  ];
  fs.writeFileSync(claude, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  const records = [
    { type: 'response_item', timestamp: start, payload: {
      type: 'function_call', call_id: 'soft', name: 'exec_command', arguments: '{"cmd":"python task.py; echo done"}',
    } },
    { type: 'response_item', timestamp: end, payload: {
      type: 'function_call_output', call_id: 'soft', output: JSON.stringify({ exit_code: 0, output }),
    } },
  ];
  fs.writeFileSync(codex, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  const events = (await parseClaude(claude)).events;
  assert.equal(events.find((event) => event.type === 'tool_end').error, true);
  assert.equal((await parseCodex(codex)).events.find((event) => event.type === 'tool_end').error, true);
  const agents = Array.from({ length: 7 }, (_, i) => entry(`h${32 + i}`));
  const accumulators = agents.map((agent) => reduce(agent, events));
  for (let i = 0; i < 20; i += 1) {
    foldEvent(accumulators[0], toolEvent(`other${i}`, 'Bash', { command: 'npm test' }, start));
    foldEvent(accumulators[0], resultEvent(`other${i}`, end, 'Error: unrelated failure', true));
  }
  const run = foldRun({ anchor: 'test:p1', ledger: { agents }, accumulators });
  assert.match(run.errorClusters[0].signature, /^UnicodeDecodeError:/);
  assert.equal(run.errorClusters[0].agents.length, 7);
  assert.equal(run.errorClusters[0].count, 7);
  assert.equal(run.errorClusters[1].count, 20);
});

test('error output recognizes diagnostics while signatures reject code and generic wrappers', () => {
  const diagnostics = [
    'Traceback (most recent call last):', 'sh: tool: command not found',
    'cat: missing.txt: No such file or directory', 'src/a.ts(1,2): error TS2304: Cannot find name',
    'npm ERR! install failed', 'fatal: bad revision', 'Error: failed operation',
  ];
  for (const output of diagnostics) assert.equal(hasErrorOutput(output), true, output);
  assert.equal(hasErrorOutput('PURPOSES = {"hook", "setup", "error"}'), false);
  assert.equal(hasErrorOutput('const message = "Error: example";'), false);
  assert.equal(hasErrorOutput('sys.exit(1 if failures else 0)'), false);
  assert.equal(errorSignature('PURPOSES = {"hook", "setup", "error"}'), 'Command failed');
  assert.equal(errorSignature("Exit code 1\nprint('failed')"), 'Command failed');
  assert.equal(errorSignature('Command failed\nExit code 1\nError: specific failure'), 'Error: specific failure');
  assert.equal(errorSignature('Error: Command failed\nNo such file or directory'), 'No such file or directory');
});

test('redirects omit descriptors and null devices while retaining real file writes', () => {
  const command = 'cat src/a.ts 2>&1 > /dev/null; cat src/b.ts 2> &1 >NUL; cat src/c.ts > $null; cat src/d.ts 2>>errors.log';
  const pieces = analyzeShell(command);
  assert.deepEqual(pieces.flatMap((piece) => piece.written), ['errors.log']);
  assert.deepEqual(pieces.flatMap((piece) => piece.read), ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
});

test('shell calls use one primary category with full time and error while keeping piece paths', () => {
  const command = '$render = 1; echo test; cd build; cat src/a.ts | head -n 2; npm test; npx remotion render Demo out.mp4 > logs/render.txt';
  const call = toolEvent('chain', 'Bash', { command }, start);
  assert.equal(primaryCategory(call.shell), 'render');
  assert.equal(primaryCategory(analyzeShell('echo render; cd build; git status | grep test')), 'git');
  assert.equal(primaryCategory(analyzeShell('git status | grep render')), 'git');
  assert.equal(primaryCategory(analyzeShell('head src/a.ts')), 'read');
  assert.equal(analyzeShell('cd C:/work', { worktree: 'C:/work' }).length, 1);
  assert.equal(primaryCategory(analyzeShell('cd C:/work', { worktree: 'C:/work' })), 'other');
  const acc = reduce(entry(), [call, resultEvent('chain', end, 'Error: render failed', false, 365)]);
  const agent = snapshotAgent(acc);
  assert.deepEqual(agent.shell, [{ category: 'render', count: 1, seconds: 365, errors: 1 }]);
  assert.ok(agent.files.read.some((file) => file.path === 'src/a.ts'));
  assert.ok(call.files.written.includes('logs/render.txt'));
  assert.equal(agent.timeline.find((span) => span.kind === 'tool').category, 'render');
  const priorities = ['render', 'test', 'build', 'install', 'script', 'git', 'edit', 'read', 'cleanup', 'other'];
  for (let i = 0; i < priorities.length; i += 1) {
    const pieces = priorities.slice(i).reverse().map((category) => ({ category, command: 'useful' }));
    assert.equal(primaryCategory(pieces), priorities[i]);
  }
});

test('generic failures stay counted without merging unrelated errors into a cluster', () => {
  const agents = [entry('h1'), entry('h2')];
  const events = [
    toolEvent('generic', 'Bash', { command: 'custom' }, start),
    resultEvent('generic', end, 'Exit code 1\nPURPOSES = {"hook", "error"}', true),
  ];
  const run = foldRun({ anchor: 'test:p1', ledger: { agents }, accumulators: agents.map((agent) => reduce(agent, events)) });
  assert.equal(run.totals.errors, 2);
  assert.deepEqual(run.errorClusters, []);
});

test('context jumps compare requests within their transcript and name the responsible tool', () => {
  const agent = entry();
  const acc = createAgent(agent);
  foldEvent(acc, { type: 'context', at: start, id: 'one', size: 10000 }, { source: 'one' });
  foldEvent(acc, { type: 'context', at: end, id: 'two', size: 100000 }, { source: 'two' });
  let run = foldRun({ anchor: 'test:p1', ledger: { agents: [agent] }, accumulators: [acc] });
  assert.equal(run.flags.some((flag) => flag.kind === 'context_growth'), false);
  foldEvent(acc, toolEvent('read', 'Read', { file_path: 'src/a.ts' }, end), { source: 'one' });
  foldEvent(acc, { type: 'context', at: end, id: 'three', size: 70000 }, { source: 'one' });
  run = foldRun({ anchor: 'test:p1', ledger: { agents: [agent] }, accumulators: [acc] });
  assert.match(run.flags.find((flag) => flag.kind === 'context_growth').message, /after Read src\/a.ts/);
});

test('flags cap duplicate reads and edit churn and require context pressure or a large jump', () => {
  const agents = [entry('h1'), entry('h2'), entry('h3')];
  const accumulators = agents.map((agent) => createAgent(agent));
  for (const acc of accumulators) {
    for (let i = 0; i < 12; i += 1) {
      foldEvent(acc, { type: 'file', path: `src/file${i}.ts`, operation: 'read' });
      for (let j = 0; j < i + 1; j += 1) foldEvent(acc, { type: 'file', path: `src/file${i}.ts`, operation: 'written' });
    }
    foldEvent(acc, { type: 'context', id: 'first', at: start, size: 30000 });
    foldEvent(acc, { type: 'context', id: 'second', at: end, size: 65000 });
  }
  accumulators[0].readTokens.set('src/file4.ts', 9000);
  const run = foldRun({ anchor: 'test:p1', ledger: { agents }, accumulators });
  assert.equal(run.flags.filter((flag) => flag.kind === 'duplicate_reads').length, 10);
  assert.match(run.flags.find((flag) => flag.kind === 'duplicate_reads').message, /^src\/file4.ts/);
  assert.equal(run.flags.filter((flag) => flag.kind === 'edit_churn').length, 10);
  assert.match(run.flags.find((flag) => flag.kind === 'edit_churn').message, /written 12 times/);
  assert.equal(run.flags.some((flag) => flag.kind === 'context_growth'), false);
  foldEvent(accumulators[0], { type: 'context', id: 'third', at: '2026-11-01T00:00:21.000Z', size: 116000 });
  foldEvent(accumulators[1], { type: 'context', id: 'third', at: '2026-11-01T00:00:21.000Z', size: 71000, window: 100000 });
  const updated = foldRun({ anchor: 'test:p1', ledger: { agents }, accumulators });
  const growth = updated.flags.filter((flag) => flag.kind === 'context_growth');
  assert.equal(growth.length, 2);
  assert.ok(growth.every((flag) => flag.message.includes('after request context')));
  assert.ok(growth.some((flag) => flag.message.includes('51000')));
  assert.ok(growth.some((flag) => flag.message.includes('70%')));
  assert.equal(updated.flags.slice(updated.flags.findIndex((flag) => flag.severity === 'info'))
    .every((flag) => flag.severity === 'info'), true);
});
