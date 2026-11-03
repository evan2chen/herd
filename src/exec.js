import { spawnSync } from 'node:child_process';

const MAX_BUFFER = 64 * 1024 * 1024;

function finish(result) {
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function run(command, args, { timeoutMs = 120000 } = {}) {
  return finish(spawnSync(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
  }));
}

export function runShell(commandLine, { timeoutMs = 120000, cwd } = {}) {
  return finish(spawnSync(commandLine, {
    encoding: 'utf8',
    shell: true,
    cwd,
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
  }));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
