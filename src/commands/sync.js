import { anchorContext } from '../context.js';
import { EXIT, HerdError } from '../errors.js';
import { commitAll, mergeInto } from '../git.js';
import { ACTIVE_STATES, findAgent, requireWorktree, withLedger } from '../ledger.js';
import { print } from '../output.js';
import { currentTarget, workSummary } from './integrate.js';

export const summary = 'Merge the main checkout\'s branch into an agent\'s worktree so the agent can resolve conflicts';
export const usage = 'herd sync <id>';
export const options = {};

export async function run(_values, [id]) {
  if (!id) throw new HerdError('usage', 'an agent id is required', { exitCode: EXIT.usage, help: [usage] });
  const anchor = anchorContext();
  const result = await withLedger(anchor, (ledger) => {
    const entry = findAgent(ledger, id);
    requireWorktree(entry, { write: true });
    if (ACTIVE_STATES.includes(entry.state)) {
      throw new HerdError('agent_active', `${id} is ${entry.state}`, { help: [`Run \`herd wait ${id}\` until it reports`] });
    }
    const target = currentTarget(entry);
    commitAll(entry.worktree, `${id}: ${workSummary(entry)}`, entry.generated ?? []);
    const { conflicts } = mergeInto(entry.worktree, target);
    entry.syncConflicts = conflicts;
    return conflicts.length
      ? {
          id,
          target,
          conflicts,
          help: [`Run \`herd send ${id} "Resolve the merge conflicts in ${conflicts.join(', ')} and report"\`, then integrate again`],
        }
      : { id, target, conflicts };
  });
  print(result);
}
