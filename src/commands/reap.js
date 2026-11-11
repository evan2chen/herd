import { anchorContext } from '../context.js';
import { deleteBranch, isAncestor, prune, removeWorktree, statusEntries } from '../git.js';
import { ACTIVE_STATES, withLedger } from '../ledger.js';
import { print } from '../output.js';
import { closePaneIfLive, pruneOverflowTabs } from '../tabs.js';
import { buildRecap } from './recap.js';

export const summary = 'Close finished panes and remove worktrees whose work is integrated, discarded or read-only';
export const usage = 'herd reap';
export const options = {};

const FINISHED_STATES = ['reported', 'closed', 'failed'];

function age(since) {
  const minutes = Math.floor((Date.now() - Date.parse(since)) / 60000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function decide(entry) {
  if (entry.reaped || entry.state === 'queued' || ACTIVE_STATES.includes(entry.state)) return null;
  if (!entry.worktree) return ['integrated', 'discarded', ...FINISHED_STATES].includes(entry.state) ? { remove: true, reason: 'finished' } : null;
  if (entry.state === 'discarded') return { remove: true, reason: 'discarded', deleteBranch: Boolean(entry.branch) };
  if (entry.state === 'integrated') {
    if (entry.integratedCommit && !isAncestor(entry.repo, entry.integratedCommit, entry.target)) {
      return { remove: false, reason: `integrated commit ${entry.integratedCommit.slice(0, 12)} is no longer on ${entry.target}` };
    }
    if (statusEntries(entry.worktree, entry.generated ?? []).length) return { remove: false, reason: 'worktree changed after integration' };
    return { remove: true, reason: 'integrated', deleteBranch: true };
  }
  if (entry.mode === 'read' && FINISHED_STATES.includes(entry.state)) return { remove: true, reason: 'read-only finished' };
  return { remove: false, reason: 'needs `herd integrate` or `herd discard`' };
}

export async function run() {
  const anchor = anchorContext();
  const result = await withLedger(anchor, async (ledger) => {
    const decisions = ledger.agents.map((entry) => [entry, decide(entry)]).filter(([, decision]) => decision);
    const recap = {};
    if (decisions.some(([, decision]) => decision.remove)) {
      try {
        const saved = await buildRecap({ anchor, ledger });
        recap.recap = saved.file;
        recap.help = saved.help;
      } catch (err) {
        recap.recapError = err.message;
      }
    }
    const removed = [];
    const kept = [];
    const repos = new Set();
    for (const [entry, decision] of decisions) {
      if (!decision.remove) {
        kept.push({ id: entry.id, state: entry.state, reason: decision.reason, age: age(entry.reportedAt ?? entry.started ?? entry.queued) });
        continue;
      }
      closePaneIfLive(anchor, entry.pane);
      if (entry.worktree) {
        await removeWorktree(entry.repo, entry.worktree);
        if (decision.deleteBranch) deleteBranch(entry.repo, entry.branch);
        repos.add(entry.repo);
      }
      entry.reaped = new Date().toISOString();
      removed.push({ id: entry.id, reason: decision.reason });
    }
    for (const repo of repos) prune(repo);
    return { ...recap, removed, kept, tabsClosed: pruneOverflowTabs(ledger, anchor) };
  });
  print(result);
}
