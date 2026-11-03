import path from 'node:path';
import { agentFiles, writeBrief } from './agent-files.js';
import { adapterFor, launchArgs, repoSettings } from './config.js';
import { EXIT, HerdError } from './errors.js';
import { sleep } from './exec.js';
import { createWorktree, repoInfo, statusEntries, worktreeRoot } from './git.js';
import * as herdr from './herdr.js';
import { ACTIVE_STATES, updateAgent, withLedger } from './ledger.js';
import { chooseSplit, chooseTab, nextOverflowLabel } from './placement.js';
import { applyPolicy } from './policy.js';
import { selectProvider } from './routing.js';
import { closePaneIfLive } from './tabs.js';
import { logUsage } from './usage.js';

const MAX_NAME_LENGTH = 32;
const PROMPT_TIMEOUT_MS = 30000;
const PROMPT_SETTLE_MS = 1500;
const RESUBMIT_WAIT_MS = 10000;
const STARTUP_POLL_MS = 1000;
const STARTUP_KEY_COOLDOWN_MS = 3000;
const QUOTA_RETRY_MS = 15 * 60000;

export function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
}

function agentId(counter, slug) {
  const prefix = `h${counter}-`;
  return `${prefix}${slug.slice(0, MAX_NAME_LENGTH - prefix.length).replace(/-+$/, '')}`;
}

export function briefPrompt(entry) {
  const prompt = `Read ${entry.brief} and follow it.`;
  if (!entry.failovers?.length) return prompt;
  const review = entry.worktree ? 'review them with `git status` and `git diff`' : 'review the files in your working directory';
  return `${prompt} Another agent started this task before you and may have left partial changes; ${review}, then continue from there.`;
}

const FAILOVER_RESET = [
  'pane', 'tab', 'promptConfirmed', 'error', 'nudged', 'stalledEventAt', 'longRunningEventAt',
  'blockedEventAt', 'reportCorrected', 'reportInvalidMtime', 'notBefore', 'waitReason', 'quotaNotified',
];

export function requeueForFailover(entry, anchor, { reason, provider = null, avoidCurrent = false }) {
  closePaneIfLive(anchor, entry.pane);
  entry.failovers = [...(entry.failovers ?? []), { from: `${entry.provider}/${entry.model}`, reason, at: new Date().toISOString() }];
  if (avoidCurrent) entry.avoid = [...new Set([...entry.avoid, entry.provider])];
  for (const key of FAILOVER_RESET) delete entry[key];
  Object.assign(entry, { state: 'queued', requestedProvider: provider });
}

function notifyQuotaWait(config, entry) {
  if (!config.notifications || entry.quotaNotified) return;
  try {
    herdr.notify('herd: every provider is below quota', `${entry.id} waits until ${entry.notBefore}`);
  } catch {
    return;
  }
  entry.quotaNotified = true;
}

function isolate(id, origin, mode) {
  const repo = repoInfo(origin);
  if (!repo) {
    if (mode === 'write') {
      throw new HerdError('not_a_repo', `${origin} is not inside a git repository`, {
        exitCode: EXIT.usage,
        help: ['Write agents work in git worktrees; run `git init` or spawn a read-only agent'],
      });
    }
    return { cwd: origin, repo: null, worktree: null, branch: null, base: null, warnings: [] };
  }
  const worktree = path.join(worktreeRoot(repo.toplevel), id);
  const branch = mode === 'write' ? `herd/${id}` : null;
  createWorktree({ toplevel: repo.toplevel, worktree, branch, base: repo.head });
  const dirty = statusEntries(repo.toplevel).length > 0;
  return {
    cwd: path.join(worktree, path.relative(repo.toplevel, origin)),
    repo: repo.toplevel,
    target: repo.branch,
    worktree,
    branch,
    base: repo.head,
    warnings: dirty ? [`uncommitted changes in ${repo.toplevel} are not in the worktree; it starts from ${repo.head.slice(0, 12)}`] : [],
  };
}

export async function enqueue(anchor, config, { tier, task, slug, provider, avoid, cwd, mode, scope }) {
  return withLedger(anchor, (ledger) => {
    const taken = new Set([
      ...herdr.agentList().map((agent) => agent.name).filter(Boolean),
      ...ledger.agents.map((agent) => agent.id),
    ]);
    let id;
    do {
      ledger.counter += 1;
      id = agentId(ledger.counter, slug);
    } while (taken.has(id));
    const { warnings, ...isolation } = isolate(id, cwd, mode);
    const files = agentFiles(isolation.cwd, id);
    const entry = {
      id,
      state: 'queued',
      tier,
      mode,
      scope,
      requestedProvider: provider ?? null,
      avoid,
      origin: cwd,
      ...isolation,
      verify: isolation.repo ? repoSettings(config, isolation.repo).verify : [],
      task,
      brief: files.brief,
      report: files.report,
      round: 1,
      queued: new Date().toISOString(),
    };
    writeBrief(entry, anchor.pane);
    ledger.agents.push(entry);
    return { ...entry, warnings };
  });
}

function place(ledger, anchor, config, cwd, env) {
  const tabs = herdr.tabList(anchor.workspace);
  const liveTabIds = new Set(tabs.map((tab) => tab.tab_id));
  ledger.tabs = ledger.tabs.filter((tab) => liveTabIds.has(tab.tab_id));
  const paneCounts = new Map(tabs.map((tab) => [tab.tab_id, tab.pane_count]));
  const tabId = chooseTab([anchor.tab, ...ledger.tabs.map((tab) => tab.tab_id)], paneCounts, config.max_panes_per_tab);

  if (tabId) {
    const reference = tabId === anchor.tab
      ? anchor.pane
      : herdr.paneList(anchor.workspace).find((pane) => pane.tab_id === tabId).pane_id;
    const split = chooseSplit(herdr.paneLayout(reference).panes, anchor.pane);
    const pane = herdr.paneSplit({ pane: split.pane, direction: split.direction, cwd, env });
    return { pane: pane.pane_id, tab: tabId };
  }

  const label = nextOverflowLabel(ledger.tabs.map((tab) => tab.label));
  const created = herdr.tabCreate({ workspace: anchor.workspace, cwd, label, env });
  ledger.tabs.push({ tab_id: created.tab.tab_id, label });
  return { pane: created.root_pane.pane_id, tab: created.tab.tab_id };
}

function claimNext(ledger, anchor, config) {
  const active = ledger.agents.filter((agent) => ACTIVE_STATES.includes(agent.state)).length;
  if (active >= config.max_active) return null;
  const now = Date.now();
  const ready = ledger.agents.filter((agent) => agent.state === 'queued' && (!agent.notBefore || Date.parse(agent.notBefore) <= now));
  for (const entry of ready) {
    let choice;
    try {
      choice = selectProvider(config, entry.tier, { provider: entry.requestedProvider ?? undefined, avoid: entry.avoid });
    } catch (err) {
      if (err.code !== 'no_provider') {
        Object.assign(entry, { state: 'failed', error: err.message });
        continue;
      }
      entry.notBefore = err.details.earliestReset ?? new Date(now + QUOTA_RETRY_MS).toISOString();
      entry.waitReason = 'quota';
      notifyQuotaWait(config, entry);
      continue;
    }
    const slot = place(ledger, anchor, config, entry.cwd, { HERD_ID: entry.id });
    delete entry.notBefore;
    delete entry.waitReason;
    Object.assign(entry, {
      state: 'starting',
      provider: choice.provider,
      model: choice.model,
      pane: slot.pane,
      tab: slot.tab,
      started: new Date().toISOString(),
    });
    return { ...entry };
  }
  return null;
}

function isReady(agent) {
  return agent.interactive_ready === true && ['idle', 'done'].includes(agent.agent_status);
}

async function startAgent(entry, adapter, config, args) {
  const timeoutMs = Math.min(config.startup_timeout_seconds * 1000, 300000);
  try {
    herdr.agentStart({ name: entry.id, kind: adapter.kind, pane: entry.pane, args, timeoutMs });
  } catch (err) {
    if (err.code !== 'agent_not_ready') throw err;
  }

  const deadline = Date.now() + timeoutMs;
  const lastSent = new Map();
  while (Date.now() < deadline) {
    const screen = herdr.agentRead(entry.id, { source: 'visible', lines: 60 });
    const dialog = adapter.startup_prompts.find((prompt) => screen.includes(prompt.match));
    if (dialog) {
      if (Date.now() - (lastSent.get(dialog.match) ?? 0) > STARTUP_KEY_COOLDOWN_MS) {
        herdr.agentSendKeys(entry.id, dialog.keys);
        lastSent.set(dialog.match, Date.now());
      }
    } else if (isReady(herdr.agentGet(entry.id))) {
      return;
    }
    await sleep(STARTUP_POLL_MS);
  }
  throw new HerdError('startup_blocked', `${entry.id} is waiting on a startup dialog herd does not recognize`, {
    help: [`Run \`herd peek ${entry.id}\` to see the dialog`, `Add its text and keys to adapters.${entry.provider}.startup_prompts in config.toml`],
  });
}

function submissionObserved(id) {
  try {
    herdr.agentWait(id, { until: ['working', 'blocked', 'done'], timeoutMs: RESUBMIT_WAIT_MS });
    return true;
  } catch (err) {
    if (err.code === 'timeout') return false;
    throw err;
  }
}

async function promptNewAgent(entry) {
  await sleep(PROMPT_SETTLE_MS);
  try {
    herdr.agentPrompt(entry.id, briefPrompt(entry), { until: ['working', 'blocked'], timeoutMs: PROMPT_TIMEOUT_MS });
    return true;
  } catch (err) {
    if (err.code !== 'agent_prompt_stalled') throw err;
  }
  herdr.agentSendKeys(entry.id, ['enter']);
  return submissionObserved(entry.id);
}

async function launch(anchor, config, entry) {
  const adapter = adapterFor(config, entry.provider);
  try {
    herdr.paneRename(entry.pane, `${entry.id} ${entry.provider}/${entry.model}`);
    const policy = applyPolicy(config, adapter, entry);
    await updateAgent(anchor, entry.id, { generated: policy.generated });
    await startAgent(entry, adapter, config, [...launchArgs(adapter, entry.model), ...policy.args]);
    const promptConfirmed = await promptNewAgent(entry);
    const changes = { state: 'running', promptConfirmed, turnStarted: new Date().toISOString() };
    await updateAgent(anchor, entry.id, changes);
    return { ...entry, ...changes };
  } catch (err) {
    if (err.code === 'startup_blocked') {
      await updateAgent(anchor, entry.id, { state: 'blocked', error: err.message, turnStarted: new Date().toISOString() });
      throw err;
    }
    try {
      herdr.paneClose(entry.pane);
    } catch {
      err.help = [...(err.help ?? []), `Pane ${entry.pane} could not be closed; close it manually`];
    }
    await updateAgent(anchor, entry.id, { state: 'failed', error: err.message });
    logUsage(anchor, entry, 'start_failed', err.message);
    throw err;
  }
}

export async function drainQueue(anchor, config) {
  const started = [];
  const failed = [];
  while (true) {
    const claimed = await withLedger(anchor, (ledger) => claimNext(ledger, anchor, config));
    if (!claimed) break;
    try {
      started.push(await launch(anchor, config, claimed));
    } catch (error) {
      failed.push({ entry: claimed, error });
    }
  }
  return { started, failed };
}
