import fs from 'node:fs';
import { parse } from 'smol-toml';
import { HerdError } from './errors.js';
import { configPath, samePath } from './paths.js';

export const TIERS = ['deep', 'standard', 'fast'];

export const DEFAULT_CONFIG = {
  cutoff_percent: 10,
  max_panes_per_tab: 4,
  max_active: 6,
  quota_cache_seconds: 60,
  startup_timeout_seconds: 90,
  idle_nudge_seconds: 30,
  long_running_minutes: 15,
  verify_timeout_minutes: 20,
  rate_limit_cooldown_minutes: 15,
  auto_failover: true,
  notifications: true,
  repos: {},
  policy: {
    allow_commands: [
      'ls', 'dir', 'pwd', 'cat', 'type', 'head', 'tail', 'wc', 'rg', 'grep', 'find',
      'Get-Content', 'Get-ChildItem', 'Get-Location', 'Select-String', 'Test-Path',
      'git status', 'git diff', 'git log', 'git show', 'git blame', 'git ls-files', 'git grep',
    ],
    deny_commands: [
      'git push', 'git commit', 'git checkout', 'git switch', 'git reset', 'git rebase', 'git merge',
      'git branch', 'git worktree', 'git stash', 'git tag', 'gh', 'npm publish', 'herd', 'herdr',
    ],
  },
  providers: ['claude', 'codex', 'cursor'],
  tiers: {
    deep: {
      claude: 'opus',
      codex: 'gpt-6-astra',
      cursor: { model: 'grok-4.7-high', quota_scope: 'grok_bot' },
    },
    standard: {
      claude: 'sonnet',
      codex: 'gpt-6.1-sol',
      cursor: 'composer-2.5',
    },
    fast: {
      claude: 'haiku',
      codex: 'gpt-6-luna',
      cursor: 'composer-2.5',
    },
  },
  adapters: {
    claude: {
      kind: 'claude',
      executable: 'claude',
      model_args: ['--model', '{model}'],
      permission_args: ['--permission-mode', 'acceptEdits'],
      policy: 'claude-settings',
      rate_limit_patterns: ["you've hit your (usage )?limit", 'usage limit reached', '(5-hour|weekly|session) limit reached'],
      startup_prompts: [
        { match: 'Yes, I trust this folder', keys: ['down', 'enter'] },
      ],
    },
    codex: {
      kind: 'codex',
      executable: 'codex',
      model_args: ['-m', '{model}'],
      permission_args: ['-s', 'workspace-write', '-a', 'on-request'],
      extra_args: ['-c', 'check_for_update_on_startup=false'],
      rate_limit_patterns: ["you've hit your usage limit", 'usage limit reached', 'rate limit reached'],
      startup_prompts: [
        { match: 'Trust this folder?', keys: ['enter'] },
      ],
      model_catalog: { file: '~/.codex/models_cache.json', pattern: '"slug"\\s*:\\s*"([^"]+)"' },
    },
    cursor: {
      kind: 'cursor',
      executable: 'cursor-agent',
      model_args: ['--model', '{model}'],
      permission_args: ['--trust', '--sandbox', 'enabled'],
      policy: 'cursor-project',
      rate_limit_patterns: ["you've hit your usage limit", 'usage limit reached', 'out of (fast )?requests'],
      startup_prompts: [],
      model_catalog: { command: 'cursor-agent models', pattern: '^(\\S+) - ' },
    },
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in base ? merge(base[key], value) : value;
  }
  return result;
}

export function loadConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) return DEFAULT_CONFIG;
  try {
    return merge(DEFAULT_CONFIG, parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    throw new HerdError('config_invalid', `${file}: ${err.message}`);
  }
}

export function tierModels(config, tier) {
  const entries = config.tiers[tier];
  if (!entries) {
    throw new HerdError('unknown_tier', `unknown tier: ${tier}`, { help: [`Use one of: ${TIERS.join(', ')}`] });
  }
  const models = {};
  for (const provider of config.providers) {
    const entry = entries[provider];
    if (!entry) continue;
    models[provider] = typeof entry === 'string'
      ? { model: entry, quota_scope: 'all_models' }
      : { model: entry.model, quota_scope: entry.quota_scope ?? 'all_models' };
  }
  return models;
}

export function adapterFor(config, provider) {
  const adapter = config.adapters[provider];
  if (!adapter) {
    throw new HerdError('unknown_provider', `no adapter configured for provider: ${provider}`, {
      help: [`Configured providers: ${Object.keys(config.adapters).join(', ')}`],
    });
  }
  return adapter;
}

export function repoSettings(config, toplevel) {
  const key = Object.keys(config.repos).find((candidate) => samePath(candidate, toplevel));
  return { verify: [], ...(key ? config.repos[key] : {}) };
}

export function launchArgs(adapter, model) {
  return [
    ...adapter.model_args.map((arg) => arg.replaceAll('{model}', model)),
    ...adapter.permission_args,
    ...(adapter.extra_args ?? []),
  ];
}
