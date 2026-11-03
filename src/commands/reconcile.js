import fs from 'node:fs';
import path from 'node:path';
import { anchorContext } from '../context.js';
import { prune, repoInfo, worktreeList, worktreeRoot } from '../git.js';
import * as herdr from '../herdr.js';
import { PANE_STATES, withLedger } from '../ledger.js';
import { print } from '../output.js';
import { samePath, sessionsRoot } from '../paths.js';
import { pruneOverflowTabs } from '../tabs.js';

export const summary = 'Repair the ledger against live Herdr and git state and list unknown herd worktrees';
export const usage = 'herd reconcile';
export const options = {};

function knownWorktrees() {
  const known = [];
  for (const session of fs.existsSync(sessionsRoot()) ? fs.readdirSync(sessionsRoot()) : []) {
    const file = path.join(sessionsRoot(), session, 'ledger.json');
    if (!fs.existsSync(file)) continue;
    for (const agent of JSON.parse(fs.readFileSync(file, 'utf8')).agents) {
      if (agent.worktree && !agent.reaped) known.push(agent.worktree);
    }
  }
  return known;
}

export async function run() {
  const anchor = anchorContext();
  const result = await withLedger(anchor, (ledger) => {
    const repairs = [];
    const livePanes = new Set(herdr.paneList(anchor.workspace).map((pane) => pane.pane_id));
    const liveAgents = new Set(herdr.agentList().map((agent) => agent.name).filter(Boolean));

    for (const entry of ledger.agents.filter((agent) => !agent.reaped)) {
      if (PANE_STATES.includes(entry.state) && !livePanes.has(entry.pane) && !liveAgents.has(entry.id)) {
        Object.assign(entry, { state: 'failed', error: 'pane vanished' });
        repairs.push({ id: entry.id, change: 'pane vanished; marked failed' });
      }
      if (entry.worktree && !fs.existsSync(entry.worktree)) {
        entry.reaped = new Date().toISOString();
        if (entry.state === 'queued' || PANE_STATES.includes(entry.state)) Object.assign(entry, { state: 'failed', error: 'worktree vanished' });
        repairs.push({ id: entry.id, change: 'worktree vanished; marked reaped' });
      }
    }

    const repos = new Set(ledger.agents.map((entry) => entry.repo).filter((repo) => repo && fs.existsSync(repo)));
    const current = repoInfo(process.cwd());
    if (current) repos.add(current.toplevel);
    const known = knownWorktrees();
    const orphans = [];
    for (const repo of repos) {
      prune(repo);
      const root = worktreeRoot(repo);
      for (const worktree of worktreeList(repo)) {
        const herdOwned = worktree.branch?.startsWith('herd/') || worktree.path.startsWith(`${root}${path.sep}`);
        if (herdOwned && !known.some((candidate) => samePath(candidate, worktree.path))) {
          orphans.push({ repo, path: worktree.path, branch: worktree.branch });
        }
      }
    }
    return { repairs, orphans, tabsClosed: pruneOverflowTabs(ledger, anchor) };
  });
  print(result);
}
