import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, tierModels } from '../config.js';
import { anchorContext } from '../context.js';
import { EXIT, HerdError } from '../errors.js';
import { drainQueue, enqueue, slugify } from '../launch.js';
import { readLedger } from '../ledger.js';
import { print } from '../output.js';

export const summary = 'Queue a task for a routed subagent in its own worktree and start it as soon as a slot and quota allow';
export const usage = 'herd spawn --tier <deep|standard|fast> --task <file> [--write [--scope <glob>]...] [--name <slug>] [--provider <name>] [--avoid <provider>]... [--cwd <dir>]';
export const options = {
  tier: { type: 'string' },
  task: { type: 'string' },
  write: { type: 'boolean' },
  scope: { type: 'string', multiple: true },
  name: { type: 'string' },
  provider: { type: 'string' },
  avoid: { type: 'string', multiple: true },
  cwd: { type: 'string' },
};

function requirePath(file, kind) {
  if (!fs.existsSync(file)) throw new HerdError(`${kind}_missing`, `${kind} not found: ${file}`, { exitCode: EXIT.usage });
}

export async function run(values) {
  if (!values.tier || !values.task) {
    throw new HerdError('usage', '--tier and --task are required', { exitCode: EXIT.usage, help: [usage] });
  }
  if (values.scope && !values.write) {
    throw new HerdError('usage', '--scope applies to write agents; add --write', { exitCode: EXIT.usage, help: [usage] });
  }
  const config = loadConfig();
  const models = tierModels(config, values.tier);
  if (values.provider && !models[values.provider]) {
    throw new HerdError('unknown_provider', `tier ${values.tier} has no model for provider ${values.provider}`, {
      exitCode: EXIT.usage,
      help: [`Providers for ${values.tier}: ${Object.keys(models).join(', ')}`],
    });
  }
  const anchor = anchorContext();
  const task = path.resolve(values.task);
  const cwd = path.resolve(values.cwd ?? process.cwd());
  requirePath(task, 'task');
  requirePath(cwd, 'cwd');

  const queued = await enqueue(anchor, config, {
    tier: values.tier,
    task,
    slug: slugify(values.name ?? path.parse(task).name),
    provider: values.provider,
    avoid: values.avoid ?? [],
    cwd,
    mode: values.write ? 'write' : 'read',
    scope: (values.scope ?? []).map((glob) => glob.replaceAll('\\', '/')),
  });
  const warnings = queued.warnings.length ? { warnings: queued.warnings } : {};
  const { started, failed } = await drainQueue(anchor, config);
  const ownFailure = failed.find(({ entry }) => entry.id === queued.id);
  if (ownFailure) throw ownFailure.error;

  const alsoStarted = started.filter((entry) => entry.id !== queued.id).map((entry) => entry.id);
  const own = started.find((entry) => entry.id === queued.id);
  if (own) {
    print({
      id: own.id,
      state: own.state,
      provider: own.provider,
      model: own.model,
      tier: own.tier,
      mode: own.mode,
      pane: own.pane,
      tab: own.tab,
      cwd: own.cwd,
      branch: own.branch,
      promptConfirmed: own.promptConfirmed,
      ...(alsoStarted.length ? { alsoStarted } : {}),
      ...warnings,
    });
    return;
  }

  const ledger = await readLedger(anchor);
  const entry = ledger.agents.find((agent) => agent.id === queued.id);
  if (entry.state !== 'queued') throw new HerdError('spawn_failed', entry.error ?? `${entry.id} is ${entry.state}`);
  const waiting = ledger.agents.filter((agent) => agent.state === 'queued');
  print({
    id: queued.id,
    state: 'queued',
    position: waiting.indexOf(entry) + 1,
    reason: entry.waitReason === 'quota' ? `every provider is below ${config.cutoff_percent}% until ${entry.notBefore}` : `max_active ${config.max_active} reached`,
    help: ['Run `herd wait` to start queued agents as slots free up'],
    ...(alsoStarted.length ? { alsoStarted } : {}),
    ...warnings,
  });
}
