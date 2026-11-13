import fs from 'node:fs';
import path from 'node:path';
import { run, sleep } from './exec.js';
import { HerdError } from './errors.js';

const REMOVE_ATTEMPTS = 6;
const REMOVE_RETRY_MS = 1000;

function git(cwd, args, { allowFail = false, timeoutMs } = {}) {
  const result = run('git', ['-C', cwd, ...args], { timeoutMs });
  if (result.status !== 0 && !allowFail) {
    throw new HerdError('git_failed', `git ${args.join(' ')}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

function out(cwd, args) {
  return git(cwd, args).stdout.trim();
}

export function repoInfo(cwd) {
  const probe = git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (probe.status !== 0) return null;
  const toplevel = path.resolve(probe.stdout.trim());
  const branch = git(toplevel, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true }).stdout.trim() || null;
  return { toplevel, head: out(toplevel, ['rev-parse', 'HEAD']), branch };
}

export function repoRoot(cwd) {
  const probe = git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true });
  return probe.status === 0 ? path.resolve(probe.stdout.trim()) : null;
}

export function statusEntries(dir, exclude = []) {
  return out(dir, ['status', '--porcelain', '--untracked-files=all'])
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => !exclude.includes(line.slice(3).replace(/^"|"$/g, '')));
}

export function isTracked(worktree, file) {
  return git(worktree, ['ls-files', '--error-unmatch', file], { allowFail: true }).status === 0;
}

export function skipWorktree(worktree, file) {
  git(worktree, ['update-index', '--skip-worktree', file]);
}

function pathspec(exclude) {
  return ['--', '.', ...exclude.map((file) => `:(exclude)${file}`)];
}

export function worktreeRoot(toplevel) {
  return path.join(path.dirname(toplevel), '.herd-worktrees', path.basename(toplevel));
}

export function createWorktree({ toplevel, worktree, branch, base }) {
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const target = branch ? ['-b', branch, worktree, base] : ['--detach', worktree, base];
  git(toplevel, ['worktree', 'add', '--quiet', ...target]);
}

export function commitAll(worktree, message, exclude = []) {
  git(worktree, ['add', '-A', ...pathspec(exclude)]);
  const merging = git(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true }).status === 0;
  const staged = git(worktree, ['diff', '--cached', '--quiet'], { allowFail: true }).status !== 0;
  if (merging) git(worktree, ['commit', '--quiet', '--no-edit']);
  else if (staged) git(worktree, ['commit', '--quiet', '-m', message]);
  return out(worktree, ['rev-parse', 'HEAD']);
}

function numstat(worktree, base) {
  const stats = new Map();
  for (const line of out(worktree, ['diff', '--numstat', base]).split(/\r?\n/).filter(Boolean)) {
    const [added, removed, file] = line.split('\t');
    stats.set(file, { added: Number(added) || 0, removed: Number(removed) || 0 });
  }
  return stats;
}

export function changedFiles(worktree, base, exclude = []) {
  const stats = numstat(worktree, base);
  const files = out(worktree, ['diff', '--name-status', base]).split(/\r?\n/).filter(Boolean).map((line) => {
    const parts = line.split('\t');
    const file = parts.at(-1);
    return { file, change: parts[0][0], ...(stats.get(file) ?? { added: 0, removed: 0 }) };
  }).filter((entry) => !exclude.includes(entry.file));
  const untracked = out(worktree, ['ls-files', '--others', '--exclude-standard'])
    .split(/\r?\n/)
    .filter((file) => file && !exclude.includes(file));
  for (const file of untracked) {
    const text = fs.readFileSync(path.join(worktree, file), 'utf8');
    files.push({ file, change: 'A', added: text ? text.split(/\r?\n/).length : 0, removed: 0 });
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

export function squashMerge(toplevel, branch, message) {
  const merge = git(toplevel, ['merge', '--squash', branch], { allowFail: true });
  if (merge.status !== 0) {
    const conflicts = out(toplevel, ['diff', '--name-only', '--diff-filter=U']).split(/\r?\n/).filter(Boolean);
    git(toplevel, ['reset', '--merge']);
    return { conflicts: conflicts.length ? conflicts : [merge.stderr.trim() || merge.stdout.trim()] };
  }
  if (git(toplevel, ['diff', '--cached', '--quiet'], { allowFail: true }).status === 0) return { commit: null };
  git(toplevel, ['commit', '--quiet', '-m', message]);
  return { commit: out(toplevel, ['rev-parse', 'HEAD']) };
}

export function mergeInto(worktree, ref) {
  const merge = git(worktree, ['merge', '--no-edit', ref], { allowFail: true });
  if (merge.status === 0) return { conflicts: [] };
  return { conflicts: out(worktree, ['diff', '--name-only', '--diff-filter=U']).split(/\r?\n/).filter(Boolean) };
}

export function isAncestor(toplevel, commit, ref) {
  return git(toplevel, ['merge-base', '--is-ancestor', commit, ref], { allowFail: true }).status === 0;
}

export function revParse(dir, ref) {
  const result = git(dir, ['rev-parse', '--verify', '-q', ref], { allowFail: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

export async function removeWorktree(toplevel, worktree) {
  for (let attempt = 1; ; attempt += 1) {
    const result = git(toplevel, ['worktree', 'remove', '--force', worktree], { allowFail: true });
    if (result.status === 0 || !fs.existsSync(worktree)) break;
    if (attempt === REMOVE_ATTEMPTS) throw new HerdError('worktree_locked', `could not remove ${worktree}: ${result.stderr.trim()}`);
    await sleep(REMOVE_RETRY_MS);
  }
  fs.rmSync(worktree, { recursive: true, force: true, maxRetries: REMOVE_ATTEMPTS, retryDelay: REMOVE_RETRY_MS });
}

export function deleteBranch(toplevel, branch) {
  git(toplevel, ['branch', '-D', branch], { allowFail: true });
}

export function worktreeList(toplevel) {
  const entries = [];
  let current = null;
  for (const line of out(toplevel, ['worktree', 'list', '--porcelain']).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: path.resolve(line.slice('worktree '.length)), branch: null };
      entries.push(current);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }
  return entries;
}

export function prune(toplevel) {
  git(toplevel, ['worktree', 'prune']);
}
