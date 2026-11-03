import path from 'node:path';
import { anchorContext } from '../context.js';
import { EXIT, HerdError } from '../errors.js';
import { changedFiles } from '../git.js';
import { findAgent, readLedger, requireWorktree } from '../ledger.js';
import { print } from '../output.js';

export const summary = 'Show what an agent changed against its base commit and flag files outside its scope';
export const usage = 'herd diff <id>';
export const options = {};

export function outOfScope(entry, files) {
  if (entry.mode === 'read') return files.map((file) => file.file);
  if (!entry.scope.length) return [];
  return files.filter((file) => !entry.scope.some((glob) => path.matchesGlob(file.file, glob))).map((file) => file.file);
}

export async function run(_values, [id]) {
  if (!id) throw new HerdError('usage', 'an agent id is required', { exitCode: EXIT.usage, help: [usage] });
  const entry = findAgent(await readLedger(anchorContext()), id);
  requireWorktree(entry);
  const files = changedFiles(entry.worktree, entry.base, entry.generated ?? []);
  print({
    id,
    mode: entry.mode,
    base: entry.base.slice(0, 12),
    scope: entry.scope,
    totals: {
      files: files.length,
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
    },
    files,
    outOfScope: outOfScope(entry, files),
  });
}
