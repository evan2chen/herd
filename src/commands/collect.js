import { archiveReport, readReport } from '../agent-files.js';
import { anchorContext } from '../context.js';
import { EXIT, HerdError } from '../errors.js';
import { findAgent, withLedger } from '../ledger.js';
import { print } from '../output.js';

export const summary = 'Return an agent\'s validated report and archive it';
export const usage = 'herd collect <id>';
export const options = {};

export async function run(_values, [id]) {
  if (!id) throw new HerdError('usage', 'an agent id is required', { exitCode: EXIT.usage, help: [usage] });
  const anchor = anchorContext();
  const result = await withLedger(anchor, (ledger) => {
    const entry = findAgent(ledger, id);
    const report = readReport(entry);
    if (report.state !== 'valid') {
      throw new HerdError('no_report', `${id} has no valid report yet`, {
        details: report.errors ? { errors: report.errors } : undefined,
        help: [`Run \`herd wait ${id}\` until it reports`],
      });
    }
    const archived = archiveReport(entry, anchor.pane, `${id}.json`);
    entry.collected = new Date().toISOString();
    return { ...report.report, round: entry.round, cwd: entry.cwd, archived };
  });
  print(result);
}
