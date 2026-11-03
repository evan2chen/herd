import { anchorContext } from '../context.js';
import { EXIT, HerdError } from '../errors.js';
import { commitAll } from '../git.js';
import { findAgent, withLedger } from '../ledger.js';
import { print } from '../output.js';
import { logUsage } from '../usage.js';

export const summary = 'Mark an agent\'s work as discarded so reap removes it; the final commit stays recoverable until git gc';
export const usage = 'herd discard <id>';
export const options = {};

export async function run(_values, [id]) {
  if (!id) throw new HerdError('usage', 'an agent id is required', { exitCode: EXIT.usage, help: [usage] });
  const anchor = anchorContext();
  const result = await withLedger(anchor, (ledger) => {
    const entry = findAgent(ledger, id);
    if (entry.state === 'integrated') throw new HerdError('already_integrated', `${id} was integrated as ${entry.integratedCommit}`);
    const head = entry.mode === 'write' && entry.worktree ? commitAll(entry.worktree, `${id}: discarded work`, entry.generated ?? []) : null;
    Object.assign(entry, { state: 'discarded', discardedHead: head, discardedAt: new Date().toISOString() });
    logUsage(anchor, entry, 'discarded', head);
    return head
      ? { id, head, help: [`Recover with \`git branch <name> ${head}\` until git garbage-collects it`, 'Run `herd reap` to remove the worktree'] }
      : { id, help: ['Run `herd reap` to remove the worktree'] };
  });
  print(result);
}
