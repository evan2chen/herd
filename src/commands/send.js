import fs from 'node:fs';
import { archiveReport } from '../agent-files.js';
import { anchorContext } from '../context.js';
import { EXIT, HerdError } from '../errors.js';
import * as herdr from '../herdr.js';
import { PANE_STATES, findAgent, withLedger } from '../ledger.js';
import { print } from '../output.js';

export const summary = 'Send a follow-up prompt to an agent, reopening it if it already reported';
export const usage = 'herd send <id> <text>';
export const options = {};

const FOLLOW_UP_RESET = ['reportStatus', 'reportedAt', 'reportCorrected', 'reportInvalidMtime', 'nudged', 'stalledEventAt', 'longRunningEventAt', 'blockedEventAt'];

export async function run(_values, [id, ...words]) {
  const text = words.join(' ').trim();
  if (!id || !text) throw new HerdError('usage', 'an agent id and prompt text are required', { exitCode: EXIT.usage, help: [usage] });
  const anchor = anchorContext();
  return withLedger(anchor, (ledger) => {
    const entry = findAgent(ledger, id);
    if (!PANE_STATES.includes(entry.state)) {
      throw new HerdError('agent_not_open', `${id} is ${entry.state}`, { help: ['Spawn a new agent for further work'] });
    }
    const archived = fs.existsSync(entry.report) ? archiveReport(entry, anchor.pane, `${id}.${entry.round}.json`) : null;
    if (archived) fs.rmSync(entry.report);
    let confirmed = true;
    try {
      herdr.agentPrompt(id, text, { until: ['working', 'blocked'], timeoutMs: 30000 });
    } catch (err) {
      if (err.code !== 'agent_prompt_stalled') {
        if (archived) fs.copyFileSync(archived, entry.report);
        if (err.code === 'agent_blocked') err.help = [`Run \`herd peek ${id}\` to see the dialog, then answer it with \`herd keys ${id} <key>...\``];
        throw err;
      }
      confirmed = false;
    }
    for (const key of FOLLOW_UP_RESET) delete entry[key];
    Object.assign(entry, { state: 'running', round: entry.round + 1, turnStarted: new Date().toISOString() });
    print({ id, round: entry.round, confirmed });
  });
}
