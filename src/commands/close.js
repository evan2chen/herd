import { anchorContext } from '../context.js';
import { EXIT, HerdError } from '../errors.js';
import * as herdr from '../herdr.js';
import { OPEN_STATES, findAgent, withLedger } from '../ledger.js';
import { print } from '../output.js';
import { pruneOverflowTabs } from '../tabs.js';

export const summary = 'Close agent panes, cancel queued agents, and remove overflow tabs left empty; worktrees stay for reap';
export const usage = 'herd close <id>... | herd close --all';
export const options = {
  all: { type: 'boolean' },
};

export async function run(values, ids) {
  if (!values.all && !ids.length) throw new HerdError('usage', 'agent ids or --all are required', { exitCode: EXIT.usage, help: [usage] });
  const anchor = anchorContext();
  const result = await withLedger(anchor, (ledger) => {
    const targets = values.all
      ? ledger.agents.filter((agent) => OPEN_STATES.includes(agent.state))
      : ids.map((id) => findAgent(ledger, id));
    const livePanes = new Set(herdr.paneList(anchor.workspace).map((pane) => pane.pane_id));
    for (const agent of targets) {
      if (agent.pane && livePanes.has(agent.pane)) herdr.paneClose(agent.pane);
      if (OPEN_STATES.includes(agent.state)) agent.state = 'closed';
      agent.closed = new Date().toISOString();
    }
    return { closed: targets.map((agent) => agent.id), tabsClosed: pruneOverflowTabs(ledger, anchor) };
  });
  print(result);
}
