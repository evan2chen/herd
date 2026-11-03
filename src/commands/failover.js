import { loadConfig, tierModels } from '../config.js';
import { anchorContext } from '../context.js';
import { EXIT, HerdError } from '../errors.js';
import { drainQueue, requeueForFailover } from '../launch.js';
import { ACTIVE_STATES, findAgent, readLedger, withLedger } from '../ledger.js';
import { print } from '../output.js';
import { logUsage } from '../usage.js';

export const summary = 'Restart an agent\'s task on another provider in the same worktree, keeping its partial work';
export const usage = 'herd failover <id> [--provider <name>]';
export const options = {
  provider: { type: 'string' },
};

export async function run(values, [id]) {
  if (!id) throw new HerdError('usage', 'an agent id is required', { exitCode: EXIT.usage, help: [usage] });
  const config = loadConfig();
  const anchor = anchorContext();
  const from = await withLedger(anchor, (ledger) => {
    const entry = findAgent(ledger, id);
    if (!ACTIVE_STATES.includes(entry.state)) {
      throw new HerdError('agent_not_active', `${id} is ${entry.state}`, { help: ['Failover applies to starting, running or blocked agents'] });
    }
    if (values.provider && !tierModels(config, entry.tier)[values.provider]) {
      throw new HerdError('unknown_provider', `tier ${entry.tier} has no model for provider ${values.provider}`, { exitCode: EXIT.usage });
    }
    if (values.provider === entry.provider) {
      throw new HerdError('same_provider', `${id} already runs on ${entry.provider}`, { exitCode: EXIT.usage });
    }
    const previous = `${entry.provider}/${entry.model}`;
    logUsage(anchor, entry, 'failover', values.provider ? `manual to ${values.provider}` : 'manual');
    requeueForFailover(entry, anchor, { reason: 'manual', provider: values.provider ?? null, avoidCurrent: !values.provider });
    return previous;
  });

  const { started, failed } = await drainQueue(anchor, config);
  const ownFailure = failed.find(({ entry }) => entry.id === id);
  if (ownFailure) throw ownFailure.error;
  const own = started.find((entry) => entry.id === id);
  if (own) {
    print({ id, from, provider: own.provider, model: own.model, pane: own.pane, tab: own.tab, promptConfirmed: own.promptConfirmed });
    return;
  }
  const entry = findAgent(await readLedger(anchor), id);
  print({
    id,
    from,
    state: entry.state,
    reason: entry.waitReason === 'quota' ? `no other provider is available until ${entry.notBefore}` : `max_active ${config.max_active} reached`,
    help: ['Run `herd wait` to start it when a provider or slot frees up'],
  });
}
