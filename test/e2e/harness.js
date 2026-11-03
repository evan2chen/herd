import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from '@toon-format/toon';

export const inHerdr = process.env.HERDR_ENV === '1' && Boolean(process.env.HERDR_PANE_ID);

const herdBin = fileURLToPath(new URL('../../bin/herd.js', import.meta.url));
const herdrBin = process.env.HERDR_BIN_PATH || 'herdr';

export function herdr(...args) {
  const result = spawnSync(herdrBin, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`herdr ${args.join(' ')}: ${result.stderr}`);
  return JSON.parse(result.stdout).result;
}

export function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function initRepo(repo, files) {
  fs.mkdirSync(repo);
  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'herd e2e');
  git(repo, 'config', 'user.email', 'herd-e2e@example.invalid');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), content);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'initial');
}

export function createHarness(label, { config = '', repoFiles = null } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const workDir = repoFiles ? path.join(base, 'repo') : base;
  if (repoFiles) initRepo(workDir, repoFiles);
  const herdHome = path.join(base, '.herd-home');
  fs.mkdirSync(herdHome);
  fs.writeFileSync(path.join(herdHome, 'config.toml'), typeof config === 'function' ? config(workDir) : config);
  const workspace = herdr('pane', 'get', process.env.HERDR_PANE_ID).pane.workspace_id;
  const created = herdr('tab', 'create', '--workspace', workspace, '--cwd', workDir, '--label', label, '--no-focus');
  const env = { ...process.env, HERDR_PANE_ID: created.root_pane.pane_id, HERD_HOME: herdHome };
  const ownedTabs = new Set([created.tab.tab_id]);

  function herd(...args) {
    const result = spawnSync(process.execPath, [herdBin, ...args], { encoding: 'utf8', env, cwd: workDir, timeout: 600000 });
    let out = null;
    try {
      out = decode(result.stdout);
    } catch {
      out = null;
    }
    return { status: result.status, out, stdout: result.stdout, stderr: result.stderr, text: result.stdout + result.stderr };
  }

  function task(name, body) {
    const dir = path.join(base, 'tasks');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, `${body}\n`);
    return file;
  }

  function tabs() {
    return herdr('tab', 'list', '--workspace', workspace).tabs;
  }

  async function waitForText(id, text, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      last = herd('peek', id, '--lines', '60').stdout;
      if (last.includes(text)) return last;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    assert.fail(`${id} never showed ${text}; last output:\n${last}`);
  }

  function waitApproving(id, approveKey = 'y', maxApprovals = 3) {
    for (let approvals = 0; ; approvals += 1) {
      const result = herd('wait', id, '--timeout', '300');
      assert.equal(result.status, 0, result.text);
      const blocked = result.out.events.some((event) => event.event === 'blocked');
      if (!blocked || approvals === maxApprovals) return result;
      assert.equal(herd('keys', id, approveKey).status, 0);
    }
  }

  function cleanup() {
    herd('close', '--all');
    for (const tab of tabs().filter((entry) => ownedTabs.has(entry.tab_id))) herdr('tab', 'close', tab.tab_id);
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  }

  return {
    base,
    workDir,
    herdHome,
    tab: created.tab.tab_id,
    herd,
    task,
    tabs,
    waitForText,
    waitApproving,
    own: (tabId) => ownedTabs.add(tabId),
    cleanup,
  };
}
