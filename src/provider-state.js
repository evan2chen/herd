import fs from 'node:fs';
import path from 'node:path';
import { herdHome } from './paths.js';

function stateFile() {
  return path.join(herdHome(), 'provider-state.json');
}

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}

export function activeLimits(now = Date.now()) {
  return Object.fromEntries(Object.entries(readAll()).filter(([, limit]) => Date.parse(limit.until) > now));
}

export function markLimited(provider, minutes, reason) {
  const file = stateFile();
  const state = { ...activeLimits(), [provider]: { until: new Date(Date.now() + minutes * 60000).toISOString(), reason } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temp, file);
}
