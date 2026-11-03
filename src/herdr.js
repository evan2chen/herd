import { run } from './exec.js';
import { HerdError } from './errors.js';

function bin() {
  return process.env.HERDR_BIN_PATH || 'herdr';
}

function parseFailure(stderr, stdout) {
  for (const text of [stderr, stdout]) {
    try {
      const parsed = JSON.parse(text.trim());
      if (parsed?.error) return parsed.error;
    } catch {
      continue;
    }
  }
  return { code: 'herdr_failed', message: (stderr || stdout).trim() || 'herdr command failed' };
}

function call(args, { timeoutMs, raw = false } = {}) {
  const { status, stdout, stderr } = run(bin(), args, { timeoutMs });
  if (status !== 0) {
    const failure = parseFailure(stderr, stdout);
    throw new HerdError(failure.code, failure.message, { details: { herdr: args.slice(0, 2).join(' ') } });
  }
  if (raw) return stdout;
  const text = stdout.trim();
  return text ? JSON.parse(text).result : null;
}

function envArgs(env = {}) {
  return Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
}

export function paneGet(paneId) {
  return call(['pane', 'get', paneId]).pane;
}

export function paneList(workspaceId) {
  return call(['pane', 'list', '--workspace', workspaceId]).panes;
}

export function paneLayout(paneId) {
  return call(['pane', 'layout', '--pane', paneId]).layout;
}

export function paneSplit({ pane, direction, cwd, env }) {
  return call(['pane', 'split', '--pane', pane, '--direction', direction, '--cwd', cwd, ...envArgs(env), '--no-focus']).pane;
}

export function paneRename(paneId, label) {
  call(['pane', 'rename', paneId, label]);
}

export function paneClose(paneId) {
  call(['pane', 'close', paneId]);
}

export function tabList(workspaceId) {
  return call(['tab', 'list', '--workspace', workspaceId]).tabs;
}

export function tabCreate({ workspace, cwd, label, env }) {
  return call(['tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', label, ...envArgs(env), '--no-focus']);
}

export function tabClose(tabId) {
  call(['tab', 'close', tabId]);
}

export function agentStart({ name, kind, pane, args, timeoutMs }) {
  return call(['agent', 'start', name, '--kind', kind, '--pane', pane, '--timeout', String(timeoutMs), '--', ...args], {
    timeoutMs: timeoutMs + 15000,
  });
}

export function agentGet(name) {
  return call(['agent', 'get', name]).agent;
}

export function agentList() {
  return call(['agent', 'list']).agents;
}

export function agentRead(name, { source = 'recent-unwrapped', lines = 40 } = {}) {
  return call(['agent', 'read', name, '--source', source, '--lines', String(lines), '--format', 'text'], { raw: true });
}

export function agentPrompt(name, text, { until = [], timeoutMs } = {}) {
  const waitArgs = until.length ? ['--wait', ...until.flatMap((state) => ['--until', state])] : [];
  const timeoutArgs = timeoutMs ? ['--timeout', String(timeoutMs)] : [];
  return call(['agent', 'prompt', name, text, ...waitArgs, ...timeoutArgs], {
    timeoutMs: (timeoutMs ?? 30000) + 15000,
  }).agent;
}

export function agentWait(name, { until, timeoutMs }) {
  return call(['agent', 'wait', name, ...until.flatMap((state) => ['--until', state]), '--timeout', String(timeoutMs)], {
    timeoutMs: timeoutMs + 15000,
  }).agent;
}

export function agentSendKeys(name, keys) {
  call(['agent', 'send-keys', name, ...keys]);
}

export function notify(title, body) {
  call(['notification', 'show', title, '--body', body, '--sound', 'request']);
}
