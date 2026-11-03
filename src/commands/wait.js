import { readReport } from '../agent-files.js';
import { adapterFor, loadConfig } from '../config.js';
import { anchorContext } from '../context.js';
import { EXIT, HerdError } from '../errors.js';
import { sleep } from '../exec.js';
import * as herdr from '../herdr.js';
import { briefPrompt, drainQueue, requeueForFailover } from '../launch.js';
import { OPEN_STATES, TERMINAL_STATES, findAgent, withLedger } from '../ledger.js';
import { print } from '../output.js';
import { markLimited } from '../provider-state.js';
import { detectRateLimit } from '../ratelimit.js';
import { logUsage } from '../usage.js';

export const summary = 'Block until agents report, block, stall, hit rate limits or exit, starting queued agents and failing over as needed';
export const usage = 'herd wait [<id>...] [--all] [--timeout <seconds>]';
export const options = {
  all: { type: 'boolean' },
  timeout: { type: 'string' },
};

const POLL_MS = 2000;
const WATCHED_STATES = ['running', 'blocked'];
const INFORMATIONAL_EVENTS = ['reported', 'failed_over'];

function sendQuietly(id, text) {
  try {
    herdr.agentPrompt(id, text);
    return true;
  } catch (err) {
    if (['agent_blocked', 'agent_prompt_stalled'].includes(err.code)) return false;
    throw err;
  }
}

function rateLimitEvent(entry, config, anchor, event) {
  if (entry.rateLimitedAt) return null;
  const screen = herdr.agentRead(entry.id, { source: 'visible', lines: 40 });
  const hit = detectRateLimit(screen, adapterFor(config, entry.provider).rate_limit_patterns);
  if (!hit) return null;
  markLimited(entry.provider, config.rate_limit_cooldown_minutes, hit);
  logUsage(anchor, entry, 'rate_limited', hit);
  if (!config.auto_failover) {
    entry.rateLimitedAt = new Date().toISOString();
    return event('rate_limited', `${entry.provider}: ${hit}`);
  }
  const from = `${entry.provider}/${entry.model}`;
  requeueForFailover(entry, anchor, { reason: 'rate_limited' });
  return event('failed_over', `${from} hit a rate limit; requeued for another provider`);
}

function inspect(entry, agent, memory, config, anchor) {
  const now = Date.now();
  const event = (name, detail = '') => ({ id: entry.id, event: name, detail });
  const report = readReport(entry);

  if (report.state === 'valid') {
    Object.assign(entry, { state: 'reported', reportStatus: report.report.status, reportedAt: new Date(now).toISOString() });
    logUsage(anchor, entry, 'reported', report.report.status);
    return [event('reported', report.report.status)];
  }

  const events = [];
  if (report.state === 'invalid' && entry.reportInvalidMtime !== report.mtimeMs) {
    entry.reportInvalidMtime = report.mtimeMs;
    if (!entry.reportCorrected) {
      entry.reportCorrected = sendQuietly(entry.id, `Your report at ${entry.report} is invalid: ${report.errors.join('; ')}. Rewrite it using the format in ${entry.brief}.`);
    } else {
      events.push(event('invalid_report', report.errors.join('; ')));
    }
  }

  if (!agent) {
    Object.assign(entry, { state: 'failed', error: 'agent exited without a valid report' });
    logUsage(anchor, entry, 'exited');
    return [...events, event('exited', 'agent exited without a valid report')];
  }

  const status = agent.agent_status;
  if (status !== 'working') {
    const limit = rateLimitEvent(entry, config, anchor, event);
    if (limit) return [...events, limit];
  }
  if (status === 'blocked') {
    if (!entry.blockedEventAt) {
      entry.blockedEventAt = new Date(now).toISOString();
      events.push(event('blocked', 'waiting on an approval or question dialog'));
    }
    return events;
  }
  delete entry.blockedEventAt;
  if (entry.state === 'blocked') entry.state = 'running';

  if (status === 'working') {
    memory.idleSince = null;
    const minutes = Math.floor((now - Date.parse(entry.turnStarted)) / 60000);
    if (minutes >= config.long_running_minutes && !entry.longRunningEventAt) {
      entry.longRunningEventAt = new Date(now).toISOString();
      events.push(event('long_running', `working ${minutes}m without a report`));
    }
    return events;
  }

  if (['idle', 'done'].includes(status)) {
    memory.idleSince ??= now;
    if (now - memory.idleSince < config.idle_nudge_seconds * 1000) return events;
    if (!entry.nudged) {
      entry.nudged = sendQuietly(entry.id, `${briefPrompt(entry)} Finish by writing your report to ${entry.report}.`);
      memory.idleSince = null;
    } else if (!entry.stalledEventAt) {
      entry.stalledEventAt = new Date(now).toISOString();
      events.push(event('stalled', 'idle without a report after a reminder'));
    }
  }
  return events;
}

export async function run(values, ids) {
  const timeoutSeconds = values.timeout === undefined ? null : Number(values.timeout);
  if (timeoutSeconds !== null && !(timeoutSeconds > 0)) {
    throw new HerdError('usage', '--timeout must be a positive number of seconds', { exitCode: EXIT.usage, help: [usage] });
  }
  const config = loadConfig();
  const anchor = anchorContext();
  const deadline = timeoutSeconds === null ? Infinity : Date.now() + timeoutSeconds * 1000;
  const collected = [];
  const targetIds = await withLedger(anchor, (ledger) => (ids.length
    ? ids.map((id) => findAgent(ledger, id).id)
    : ledger.agents.filter((agent) => OPEN_STATES.includes(agent.state) && agent.state !== 'reported').map((agent) => agent.id)));
  const memory = new Map(targetIds.map((id) => [id, { idleSince: null, announced: false }]));

  while (true) {
    await drainQueue(anchor, config);
    const live = new Map(herdr.agentList().filter((agent) => agent.name).map((agent) => [agent.name, agent]));

    const round = await withLedger(anchor, (ledger) => {
      const targets = targetIds.map((id) => findAgent(ledger, id));
      const events = [];
      for (const entry of targets) {
        const state = memory.get(entry.id);
        if (WATCHED_STATES.includes(entry.state)) events.push(...inspect(entry, live.get(entry.id), state, config, anchor));
        if (TERMINAL_STATES.includes(entry.state) && !state.announced) {
          state.announced = true;
          if (!events.some((event) => event.id === entry.id && ['reported', 'exited'].includes(event.event))) {
            events.push({ id: entry.id, event: entry.state, detail: entry.reportStatus ?? entry.error ?? '' });
          }
        }
      }
      return { events, settled: targets.every((entry) => TERMINAL_STATES.includes(entry.state)) };
    });

    collected.push(...round.events);
    const wakes = collected.some((event) => event.event !== 'failed_over');
    const actionable = collected.some((event) => !INFORMATIONAL_EVENTS.includes(event.event));
    if (!targetIds.length || (values.all ? actionable || round.settled : wakes)) {
      print({ events: collected });
      return EXIT.ok;
    }
    if (Date.now() >= deadline) {
      print({ events: collected, timeout: true });
      return EXIT.timeout;
    }
    await sleep(POLL_MS);
  }
}
