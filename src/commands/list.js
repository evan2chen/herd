import { anchorContext } from '../context.js';
import * as herdr from '../herdr.js';
import { ACTIVE_STATES, OPEN_STATES, readLedger } from '../ledger.js';
import { print } from '../output.js';

export const summary = 'Show this session\'s agents with live state';
export const usage = 'herd list [--all]';
export const options = {
  all: { type: 'boolean' },
};

function age(since) {
  if (!since) return null;
  const minutes = Math.floor((Date.now() - Date.parse(since)) / 60000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export async function run(values) {
  const anchor = anchorContext();
  const ledger = await readLedger(anchor);
  const live = new Map(herdr.agentList().filter((agent) => agent.name).map((agent) => [agent.name, agent]));
  const tabLabels = new Map([[anchor.tab, 'home'], ...ledger.tabs.map((tab) => [tab.tab_id, tab.label])]);
  const agents = ledger.agents
    .filter((agent) => values.all || (OPEN_STATES.includes(agent.state) && !agent.reaped))
    .map((agent) => ({
      id: agent.id,
      state: ACTIVE_STATES.includes(agent.state) ? live.get(agent.id)?.agent_status ?? 'gone' : agent.state,
      reaped: Boolean(agent.reaped),
      result: agent.reportStatus ?? null,
      provider: agent.provider ?? null,
      model: agent.model ?? null,
      tier: agent.tier,
      mode: agent.mode,
      tab: agent.tab ? tabLabels.get(agent.tab) ?? agent.tab : null,
      age: age(agent.started ?? agent.queued),
    }));
  print({ agents });
}
