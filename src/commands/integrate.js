import { readReport } from '../agent-files.js';
import { anchorContext } from '../context.js';
import { EXIT, HerdError } from '../errors.js';
import { commitAll, repoInfo, squashMerge, statusEntries } from '../git.js';
import { ACTIVE_STATES, findAgent, requireWorktree, withLedger } from '../ledger.js';
import { print } from '../output.js';
import { logUsage } from '../usage.js';

export const summary = 'Commit an agent\'s work and squash-merge it into the main checkout\'s current branch';
export const usage = 'herd integrate <id>';
export const options = {};

const SUBJECT_LENGTH = 72;

export function workSummary(entry) {
  const report = readReport(entry);
  const text = report.state === 'valid' ? report.report.summary.split(/\r?\n/)[0].trim() : `work from ${entry.id}`;
  return text.length > SUBJECT_LENGTH ? `${text.slice(0, SUBJECT_LENGTH - 3)}...` : text;
}

export function currentTarget(entry) {
  const repo = repoInfo(entry.repo);
  if (!repo?.branch) {
    throw new HerdError('detached_target', `${entry.repo} is not on a branch`, { help: ['Check out the branch to integrate into'] });
  }
  return repo.branch;
}

export async function run(_values, [id]) {
  if (!id) throw new HerdError('usage', 'an agent id is required', { exitCode: EXIT.usage, help: [usage] });
  const anchor = anchorContext();
  const result = await withLedger(anchor, (ledger) => {
    const entry = findAgent(ledger, id);
    requireWorktree(entry, { write: true });
    if (entry.state === 'integrated') throw new HerdError('already_integrated', `${id} was integrated as ${entry.integratedCommit}`);
    if (entry.state === 'discarded') throw new HerdError('discarded', `${id} was discarded`);
    if (ACTIVE_STATES.includes(entry.state) || entry.state === 'queued') {
      throw new HerdError('agent_active', `${id} is ${entry.state}`, { help: [`Run \`herd wait ${id}\` until it reports`] });
    }
    const target = currentTarget(entry);
    if (statusEntries(entry.repo).length) {
      throw new HerdError('target_dirty', `${entry.repo} has uncommitted changes`, { help: ['Commit or stash them, then integrate again'] });
    }

    const subject = workSummary(entry);
    commitAll(entry.worktree, `${id}: ${subject}`, entry.generated ?? []);
    const merge = squashMerge(entry.repo, entry.branch, `${subject}\n\nherd ${id} (${entry.provider}/${entry.model}, ${entry.tier})`);
    if (merge.conflicts) {
      throw new HerdError('merge_conflict', `${id} conflicts with ${target}`, {
        details: { conflicts: merge.conflicts },
        help: [`Run \`herd sync ${id}\` to merge ${target} into the agent's branch, then have the agent resolve the conflicts with \`herd send\``],
      });
    }
    Object.assign(entry, { state: 'integrated', integratedCommit: merge.commit, target, integratedAt: new Date().toISOString() });
    logUsage(anchor, entry, 'integrated', merge.commit);
    return { id, commit: merge.commit, target, subject };
  });
  print(result);
}
