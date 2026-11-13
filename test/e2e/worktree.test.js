import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createHarness, git, inHerdr } from './harness.js';

const CHECK_SCRIPT = `const fs = require('fs');
const file = 'src/greet.txt';
if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() !== 'hello') {
  console.error('src/greet.txt must contain hello');
  process.exit(1);
}
console.log('check ok');
`;
const APPROVE_KEY = { claude: 'enter', codex: 'enter', cursor: 'y' };

let h;
const agents = {};

before(() => {
  if (!inHerdr) return;
  h = createHarness('herd-e2e-worktree', {
    config: (repo) => `[repos."${repo.replaceAll('\\', '/')}"]\nverify = ["node check.js"]\n`,
    repoFiles: { 'README.md': '# demo\n\nstatus: draft\n', 'check.js': CHECK_SCRIPT },
  });
});

after(() => {
  if (inHerdr) h.cleanup();
});

function spawn(name, provider, body, ...flags) {
  const result = h.herd('spawn', '--tier', 'fast', '--provider', provider, '--name', name, ...flags, '--task', h.task(name, body));
  assert.equal(result.status, 0, result.text);
  agents[name] = result.out;
  return result.out;
}

function waitReported(agent) {
  const result = h.waitApproving(agent.id, APPROVE_KEY[agent.provider]);
  const events = result.out.events.map(({ event }) => event);
  const screen = events.includes('reported') ? '' : h.herd('peek', agent.id, '--lines', '25').stdout;
  assert.deepEqual(events, ['reported'], `${result.text}\n${screen}`);
  return result.out.events[0];
}

test('a write agent works on its own branch in a separate worktree', { skip: !inHerdr, timeout: 600000 }, () => {
  const agent = spawn('greet', 'claude', 'Create the file src/greet.txt containing exactly the word hello.', '--write', '--scope', 'src/**');
  assert.equal(agent.branch, `herd/${agent.id}`);
  assert.equal(path.dirname(agent.cwd), path.join(h.base, '.herd-worktrees', 'repo'));
  assert.equal(waitReported(agent).detail, 'done');
  assert.ok(fs.existsSync(path.join(agent.cwd, 'src', 'greet.txt')));
  assert.ok(!fs.existsSync(path.join(h.workDir, 'src', 'greet.txt')));
});

test('diff lists the change inside scope', { skip: !inHerdr }, () => {
  const result = h.herd('diff', agents.greet.id);
  assert.equal(result.status, 0, result.text);
  assert.deepEqual(result.out.files.map(({ file, change }) => ({ file, change })), [{ file: 'src/greet.txt', change: 'A' }]);
  assert.deepEqual(result.out.outOfScope, []);
});

test('verify runs the configured commands in the worktree', { skip: !inHerdr }, () => {
  const result = h.herd('verify', agents.greet.id);
  assert.equal(result.status, 0, result.text);
  assert.equal(result.out.result, 'pass');
  assert.deepEqual(result.out.commands.map(({ command, exit }) => ({ command, exit })), [{ command: 'node check.js', exit: 0 }]);
});

test('integrate squash-merges the work into the main checkout', { skip: !inHerdr }, () => {
  const result = h.herd('integrate', agents.greet.id);
  assert.equal(result.status, 0, result.text);
  assert.equal(result.out.target, 'main');
  assert.equal(git(h.workDir, 'rev-parse', 'HEAD'), result.out.commit);
  assert.equal(git(h.workDir, 'log', '-1', '--format=%s'), result.out.subject);
  assert.equal(fs.readFileSync(path.join(h.workDir, 'src', 'greet.txt'), 'utf8').trim(), 'hello');
  assert.equal(git(h.workDir, 'status', '--porcelain'), '');
});

test('diff flags files outside scope and discard records the work', { skip: !inHerdr, timeout: 600000 }, () => {
  const agent = spawn('notes', 'codex', 'Create the file src/notes.txt containing exactly the word notes.', '--write', '--scope', 'src/**');
  waitReported(agent);
  fs.writeFileSync(path.join(agent.cwd, 'stray.txt'), 'outside scope\n');
  const diff = h.herd('diff', agent.id);
  assert.deepEqual(diff.out.files.map(({ file }) => file), ['src/notes.txt', 'stray.txt'], diff.text);
  assert.deepEqual(diff.out.outOfScope, ['stray.txt'], diff.text);
  const discard = h.herd('discard', agent.id);
  assert.equal(discard.status, 0, discard.text);
  assert.equal(git(h.workDir, 'rev-parse', `herd/${agent.id}`), discard.out.head);
  assert.equal(git(h.workDir, 'show', '--name-only', '--format=', discard.out.head).split('\n').sort().join(','), 'src/notes.txt,stray.txt');
});

test('a read agent gets a detached worktree and changes nothing', { skip: !inHerdr, timeout: 600000 }, () => {
  const agent = spawn('reader', 'cursor', 'Read README.md and put its first line in your report summary. Change no files.');
  assert.equal(agent.mode, 'read');
  assert.equal(agent.branch, null);
  waitReported(agent);
  const diff = h.herd('diff', agent.id);
  assert.deepEqual(diff.out.files, [], diff.text);
});

test('conflicting agents are resolved through sync and send', { skip: !inHerdr, timeout: 900000 }, () => {
  const first = spawn('review', 'claude', "In README.md, replace the line 'status: draft' with 'status: reviewed by D'.", '--write');
  const second = spawn('approve', 'claude', "In README.md, replace the line 'status: draft' with 'status: approved by E'.", '--write');
  waitReported(first);
  waitReported(second);
  const integrated = h.herd('integrate', first.id);
  assert.equal(integrated.status, 0, integrated.text);

  const clash = h.herd('integrate', second.id);
  assert.equal(clash.status, 1, clash.text);
  assert.match(clash.stderr, /merge_conflict/);
  assert.match(clash.stderr, /README\.md/);
  assert.equal(git(h.workDir, 'status', '--porcelain'), '');

  const sync = h.herd('sync', second.id);
  assert.equal(sync.status, 0, sync.text);
  assert.deepEqual(sync.out.conflicts, ['README.md']);
  const send = h.herd('send', second.id, "README.md now contains git merge conflict markers. Resolve them so the file keeps its heading and has the single status line 'status: reviewed by D and approved by E', with no conflict markers left. Then write your report.");
  assert.equal(send.status, 0, send.text);
  waitReported(second);

  const merged = h.herd('integrate', second.id);
  assert.equal(merged.status, 0, merged.text);
  const readme = fs.readFileSync(path.join(h.workDir, 'README.md'), 'utf8');
  assert.match(readme, /status: reviewed by D and approved by E/);
  assert.doesNotMatch(readme, /<<<<<<<|>>>>>>>/);
});

test('reap removes every finished worktree and branch', { skip: !inHerdr }, () => {
  const result = h.herd('reap');
  assert.equal(result.status, 0, result.text);
  assert.deepEqual(result.out.removed.map((entry) => entry.id).sort(), Object.values(agents).map((agent) => agent.id).sort(), result.text);
  assert.deepEqual(result.out.kept, []);
  assert.equal(path.dirname(result.out.recap), path.join(fs.realpathSync(h.workDir), '.herd', 'recaps'));
  assert.ok(fs.existsSync(result.out.recap));
  assert.equal(git(h.workDir, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(git(h.workDir, 'branch', '--list', 'herd/*'), '');
  assert.equal(git(h.workDir, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length, 1);
  assert.deepEqual(fs.readdirSync(path.join(h.base, '.herd-worktrees', 'repo')), []);
  assert.equal(h.tabs().find((tab) => tab.tab_id === h.tab).pane_count, 1);
  assert.deepEqual(h.herd('list').out.agents, []);
});

test('reconcile lists herd worktrees that no ledger knows about', { skip: !inHerdr }, () => {
  const orphan = path.join(h.base, '.herd-worktrees', 'repo', 'h99-orphan');
  git(h.workDir, 'worktree', 'add', '--quiet', '-b', 'herd/h99-orphan', orphan);
  const result = h.herd('reconcile');
  assert.equal(result.status, 0, result.text);
  assert.deepEqual(result.out.orphans.map((entry) => entry.branch), ['herd/h99-orphan'], result.text);
  assert.deepEqual(result.out.repairs, []);
});
