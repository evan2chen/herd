import fs from 'node:fs';
import path from 'node:path';
import { runShell } from './exec.js';
import { HerdError } from './errors.js';
import { quotaCachePath } from './paths.js';

function readCache(maxAgeSeconds) {
  try {
    const cached = JSON.parse(fs.readFileSync(quotaCachePath(), 'utf8'));
    if (Date.now() - cached.fetchedAt <= maxAgeSeconds * 1000) return cached.data;
  } catch {
    return null;
  }
  return null;
}

function writeCache(data) {
  const file = quotaCachePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ fetchedAt: Date.now(), data }));
  fs.renameSync(temp, file);
}

export function readQuota(config) {
  const cached = readCache(config.quota_cache_seconds);
  if (cached) return cached;
  const { status, stdout, stderr } = runShell(`quota-axi --provider "${config.providers.join(',')}" --json`, { timeoutMs: 60000 });
  if (status !== 0) {
    throw new HerdError('quota_unavailable', `quota-axi failed: ${(stderr || stdout).trim()}`, {
      help: ['Run `quota-axi auth` to check provider credentials'],
    });
  }
  const data = JSON.parse(stdout);
  writeCache(data);
  return data;
}
