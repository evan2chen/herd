import fs from 'node:fs';
import path from 'node:path';
import { herdHome } from './paths.js';

export function logUsage(anchor, entry, event, detail = null) {
  const since = entry.turnStarted ?? entry.started;
  const record = {
    at: new Date().toISOString(),
    session: anchor.pane,
    id: entry.id,
    event,
    tier: entry.tier,
    mode: entry.mode,
    provider: entry.provider ?? null,
    model: entry.model ?? null,
    round: entry.round,
    seconds: since ? Math.round((Date.now() - Date.parse(since)) / 1000) : null,
    detail,
  };
  const file = path.join(herdHome(), 'usage.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}
