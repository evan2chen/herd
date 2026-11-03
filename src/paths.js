import os from 'node:os';
import path from 'node:path';

export function herdHome() {
  return process.env.HERD_HOME || path.join(os.homedir(), '.herd');
}

export function configPath() {
  return path.join(herdHome(), 'config.toml');
}

export function quotaCachePath() {
  return path.join(herdHome(), 'quota-cache.json');
}

export function samePath(a, b) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

export function sessionsRoot() {
  return path.join(herdHome(), 'sessions');
}

export function sessionDir(anchorPaneId) {
  return path.join(sessionsRoot(), anchorPaneId.replace(/[^A-Za-z0-9_-]/g, '-'));
}
