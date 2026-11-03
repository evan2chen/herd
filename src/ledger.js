import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './exec.js';
import { HerdError } from './errors.js';
import { sessionDir } from './paths.js';

const LOCK_TIMEOUT_MS = 30000;
const LOCK_STALE_MS = 120000;
const LOCK_RETRY_MS = 100;

export const ACTIVE_STATES = ['starting', 'running', 'blocked'];
export const PANE_STATES = [...ACTIVE_STATES, 'reported'];
export const OPEN_STATES = ['queued', ...PANE_STATES];
export const TERMINAL_STATES = ['reported', 'failed', 'closed'];

function files(anchor) {
  const dir = sessionDir(anchor.pane);
  return { dir, ledger: path.join(dir, 'ledger.json'), lock: path.join(dir, 'ledger.lock') };
}

function emptyLedger(anchor) {
  return { version: 1, anchor, counter: 0, tabs: [], agents: [] };
}

async function acquire(lockDir) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      if (Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() > deadline) {
      throw new HerdError('ledger_locked', `ledger lock held longer than ${LOCK_TIMEOUT_MS / 1000}s: ${lockDir}`);
    }
    await sleep(LOCK_RETRY_MS);
  }
}

function load(paths, anchor) {
  if (!fs.existsSync(paths.ledger)) return emptyLedger(anchor);
  return JSON.parse(fs.readFileSync(paths.ledger, 'utf8'));
}

function save(paths, ledger) {
  const temp = `${paths.ledger}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.renameSync(temp, paths.ledger);
}

export async function withLedger(anchor, mutate) {
  const paths = files(anchor);
  fs.mkdirSync(paths.dir, { recursive: true });
  await acquire(paths.lock);
  try {
    const ledger = load(paths, anchor);
    const result = await mutate(ledger);
    save(paths, ledger);
    return result;
  } finally {
    fs.rmSync(paths.lock, { recursive: true, force: true });
  }
}

export async function readLedger(anchor) {
  return withLedger(anchor, (ledger) => structuredClone(ledger));
}

export async function updateAgent(anchor, id, changes) {
  await withLedger(anchor, (ledger) => Object.assign(findAgent(ledger, id), changes));
}

export function requireWorktree(entry, { write = false } = {}) {
  if (!entry.worktree) {
    throw new HerdError('no_worktree', `${entry.id} has no worktree because it was spawned outside a git repository`);
  }
  if (write && entry.mode !== 'write') {
    throw new HerdError('read_only_agent', `${entry.id} is a read-only agent`, { help: ['Spawn with --write for changes to integrate'] });
  }
}

export function findAgent(ledger, id) {
  const entry = ledger.agents.find((agent) => agent.id === id);
  if (!entry) {
    throw new HerdError('unknown_agent', `no agent ${id} in this session`, { help: ['Run `herd list` to see agent IDs'] });
  }
  return entry;
}
