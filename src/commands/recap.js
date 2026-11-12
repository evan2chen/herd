import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { anchorContext } from '../context.js';
import { HerdError } from '../errors.js';
import { readLedger } from '../ledger.js';
import { print } from '../output.js';
import { sessionDir } from '../paths.js';
import { renderPage } from '../telemetry/page.js';
import { buildRun } from '../telemetry/run.js';

export const summary = 'Save a self-contained recap of this session';
export const usage = 'herd recap [--out <file>]';
export const options = { out: { type: 'string' } };

const brief = (value) => String(value ?? '').slice(0, 240);

export function summarize(run, file) {
  const severity = { error: 0, warn: 1, info: 2 };
  return {
    file,
    totals: run.totals,
    quota: run.quota.map(({ provider, startPercent, endPercent }) => ({
      provider,
      usedPercent: Number.isFinite(startPercent) && Number.isFinite(endPercent) ? Math.max(0, startPercent - endPercent) : null,
    })),
    flags: [...run.flags].sort((a, b) => (severity[a.severity] ?? 3) - (severity[b.severity] ?? 3)).slice(0, 5)
      .map(({ severity, kind, agent, message }) => ({ severity, kind, agent, message: brief(message) })),
    errorClusters: [...run.errorClusters].sort((a, b) => b.count - a.count).slice(0, 3)
      .map(({ agents, signature }) => ({ agents: agents.length, signature: brief(signature) })),
    help: ['Open the recap file in a browser to explore the run'],
  };
}

export async function buildRecap({ anchor, ledger, config = loadConfig(), out, now = new Date().toISOString() }) {
  try {
    ledger ??= await readLedger(anchor);
    const snapshot = await buildRun({ anchor, ledger, config, now });
    const timestamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const file = path.resolve(out ?? path.join(sessionDir(anchor.pane), 'recaps', `${timestamp}.html`));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, renderPage(snapshot, { live: false }), 'utf8');
    return summarize(snapshot, file);
  } catch (err) {
    throw new HerdError('recap_failed', `Could not save recap: ${err.message}`, {
      help: ['Check the session data and choose a writable path with `herd recap --out <file>`'],
    });
  }
}

export async function run(values) {
  print(await buildRecap({ anchor: anchorContext(), out: values.out }));
}
