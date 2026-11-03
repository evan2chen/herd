import fs from 'node:fs';
import path from 'node:path';
import { agentFiles } from './agent-files.js';
import { isTracked, skipWorktree } from './git.js';

function split(command) {
  const [base, ...rest] = command.trim().split(/\s+/);
  return { base, args: rest.join(' ') };
}

function claudeRules({ allow, verify, deny }) {
  return {
    permissions: {
      allow: [...allow.map((command) => `Bash(${command}:*)`), ...verify.map((command) => `Bash(${command})`)],
      deny: deny.map((command) => `Bash(${command}:*)`),
    },
  };
}

function cursorRule(command, exact) {
  const { base, args } = split(command);
  if (!args) return `Shell(${base})`;
  return `Shell(${base}:${args}${exact ? '' : '*'})`;
}

function cursorRules({ allow, verify, deny }) {
  return {
    allow: [...allow.map((command) => cursorRule(command, false)), ...verify.map((command) => cursorRule(command, true))],
    deny: deny.map((command) => cursorRule(command, false)),
  };
}

function writeClaudeSettings(entry, rules) {
  const file = path.join(agentFiles(entry.cwd, entry.id).dir, 'claude-settings.json');
  fs.writeFileSync(file, `${JSON.stringify(claudeRules(rules), null, 2)}\n`);
  return { args: ['--settings', path.relative(entry.cwd, file)], generated: [] };
}

function writeCursorProject(entry, rules) {
  if (!entry.worktree) return { args: [], generated: [] };
  const file = path.join(entry.cwd, '.cursor', 'cli.json');
  const relative = path.relative(entry.worktree, file).replaceAll('\\', '/');
  const tracked = isTracked(entry.worktree, relative);
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const permissions = existing.permissions ?? {};
  const added = cursorRules(rules);
  existing.permissions = {
    ...permissions,
    allow: [...new Set([...(permissions.allow ?? []), ...added.allow])],
    deny: [...new Set([...(permissions.deny ?? []), ...added.deny])],
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`);
  if (tracked) skipWorktree(entry.worktree, relative);
  return { args: [], generated: tracked ? [] : [relative] };
}

const WRITERS = {
  'claude-settings': writeClaudeSettings,
  'cursor-project': writeCursorProject,
};

export function applyPolicy(config, adapter, entry) {
  const writer = WRITERS[adapter.policy];
  if (!writer) return { args: [], generated: [] };
  return writer(entry, {
    allow: config.policy.allow_commands,
    verify: entry.verify,
    deny: config.policy.deny_commands,
  });
}
