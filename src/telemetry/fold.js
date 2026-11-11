import { primaryCategory } from './shell.js';

const KINDS = ['model', 'tool', 'background', 'idle', 'blocked', 'queued'];
const ACTIVE = ['starting', 'running', 'blocked', 'queued'];
const zeroTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const seconds = (start, end) => Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000) || 0;

export function createAgent(entry, segments = []) {
  return {
    entry,
    segments,
    sources: new Map(),
    pending: new Map(),
    tools: new Map(),
    shell: new Map(),
    read: new Map(),
    readTokens: new Map(),
    written: new Map(),
    failures: new Map(),
    spans: [],
    markers: [],
    prompts: new Set(),
    context: { window: null, peak: null, series: [] },
    growth: null,
    request: null,
    cause: null,
    compactions: [],
    denied: [],
    errors: 0,
    firstAt: null,
    lastAt: null,
  };
}

function sourceFor(acc, key, provider) {
  if (!acc.sources.has(key))
    acc.sources.set(key, {
      provider,
      tokens: zeroTokens(),
      exact: provider !== 'cursor',
      usd: null,
      costExact: false,
      unknownPrice: false,
    });
  return acc.sources.get(key);
}

function count(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function metric(map, name) {
  if (!map.has(name)) map.set(name, { count: 0, seconds: 0, errors: 0 });
  return map.get(name);
}

export function foldEvent(
  acc,
  event,
  { source = 'default', provider = acc.entry.provider, model = acc.entry.model, prices = {} } = {},
) {
  const e = event;
  const data = sourceFor(acc, source, provider);
  if (e.at) {
    if (!acc.firstAt || e.at < acc.firstAt) acc.firstAt = e.at;
    if (!acc.lastAt || e.at > acc.lastAt) acc.lastAt = e.at;
  }
  if (e.type === 'usage') {
    if (Object.values(e.tokens).some((n) => n > 0)) data.costExact = false;
    for (const key of Object.keys(data.tokens)) data.tokens[key] += e.tokens[key] ?? 0;
    data.exact &&= e.exact;
    if (provider === 'codex') {
      const price = prices[e.model ?? model];
      const cached = price?.cached_input ?? price?.cacheRead ?? price?.cachedInput;
      if (price && Number.isFinite(price.input) && Number.isFinite(price.output) && Number.isFinite(cached)) {
        if (!data.unknownPrice)
          data.usd =
            (data.usd ?? 0) +
            (e.tokens.input * price.input + e.tokens.cacheRead * cached + e.tokens.output * price.output) / 1000000;
      } else {
        data.usd = null;
        data.unknownPrice = true;
      }
    }
  }
  if (e.type === 'cost') {
    data.usd = e.usd;
    data.costExact = e.exact && e.usd !== null;
    if (e.tokens) data.tokens = { ...e.tokens };
  }
  if (e.type === 'prompt' && e.at) {
    acc.prompts.add(e.at);
    acc.markers.push({ at: e.at, kind: 'model' });
  }
  if (e.type === 'turn_end' && e.at) acc.markers.push({ at: e.at, kind: 'idle' });
  if (e.type === 'compaction') acc.compactions.push(e.at);
  if (e.type === 'context' && e.at) {
    const previous = data.context;
    const own = data.request?.output ?? 0;
    const tool = previous ? Math.max(0, e.size - previous.size - own) : 0;
    const point = { at: e.at, size: e.size, own, tool, cause: tool ? (data.cause ?? null) : null };
    data.window = e.window ?? data.window ?? null;
    const growth = contextGrowth(point, previous, data.window);
    if (growth && (!acc.growth || growth.impact > acc.growth.impact)) acc.growth = growth;
    for (const file of data.reads ?? []) count(acc.readTokens, file, tool / data.reads.length);
    acc.context.series.push(point);
    data.context = point;
    acc.context.window = e.window ?? acc.context.window;
    acc.context.peak = Math.max(acc.context.peak ?? 0, e.size);
    if (previous && e.size < previous.size * 0.6 && previous.size > 10000 && !acc.compactions.includes(e.at))
      acc.compactions.push(e.at);
    data.request = { id: e.id, output: e.output ?? 0 };
    data.cause = null;
    data.reads = [];
  }
  if (e.type === 'request_output' && data.request?.id === e.id)
    data.request.output = Math.max(data.request.output, e.output);
  if (e.type === 'file') count(acc[e.operation], e.path);
  const key = `${source}:${e.id}`;
  if (e.type === 'tool_start') {
    metric(acc.tools, e.name).count += 1;
    if (e.shell.length) metric(acc.shell, primaryCategory(e.shell)).count += 1;
    for (const file of e.files.read) count(acc.read, file);
    if (e.untimed) for (const file of e.files.written) count(acc.written, file);
    else acc.pending.set(key, { ...e });
    data.cause = e.label;
    data.reads = [...new Set([...(data.reads ?? []), ...e.files.read])];
    if (e.at) acc.markers.push({ at: e.at, kind: 'model' });
  }
  if (e.type === 'background' && acc.pending.has(key)) acc.pending.get(key).background = true;
  if (e.type === 'tool_end') {
    const call = acc.pending.get(key);
    if (!call) return;
    const elapsed = e.seconds ?? seconds(call.at, e.at);
    const tool = metric(acc.tools, call.name);
    tool.seconds += elapsed;
    tool.errors += Number(e.error);
    const category = call.shell.length ? primaryCategory(call.shell) : null;
    if (category) {
      const shell = metric(acc.shell, category);
      shell.seconds += elapsed;
      shell.errors += Number(e.error);
    }
    if (call.at && e.at)
      acc.spans.push({
        kind: call.background ? 'background' : 'tool',
        start: call.at,
        end: e.at,
        tool: call.name,
        category,
        label: call.label,
      });
    if (!e.error) {
      for (const file of call.files.written) count(acc.written, file);
      for (const failure of acc.failures.values())
        if (!failure.recovery && failure.category === (category ?? call.name)) failure.recovery = e.at;
    } else {
      acc.errors += 1;
      const signature = e.signature ?? 'Command failed';
      if (!acc.failures.has(signature))
        acc.failures.set(signature, {
          signature,
          family: e.family ?? 'command',
          count: 0,
          at: e.at,
          recovery: null,
          category: category ?? call.name,
        });
      const failure = acc.failures.get(signature);
      failure.count += 1;
      failure.recovery = null;
      if (e.denied) acc.denied.push(e.at);
    }
    if (!call.background || e.error) data.cause = call.label;
    acc.pending.delete(key);
  }
}

function lifeEnd(acc, now, live) {
  const e = acc.entry;
  if (ACTIVE.includes(e.state)) return live ? now : (acc.lastAt ?? e.turnStarted ?? e.started ?? e.queued ?? now);
  return (
    e.reportedAt ??
    e.closedAt ??
    acc.lastAt ??
    e.integratedAt ??
    e.discardedAt ??
    e.reaped ??
    e.started ??
    e.queued ??
    now
  );
}

function timelineFor(acc, end) {
  const e = acc.entry;
  const queued = e.queued ?? e.started ?? end;
  const started = e.failovers?.length
    ? (acc.segments.find((s) => s.transcript)?.started ?? acc.firstAt ?? e.started ?? end)
    : (e.started ?? end);
  const intervals = [];
  const add = (kind, start, finish, extra = {}) => {
    if (start && finish && start < finish)
      intervals.push({ kind, start, end: finish, tool: null, category: null, label: null, ...extra });
  };
  add('queued', queued, started < end ? started : end);
  for (let i = 0; i < acc.segments.length - 1; i += 1)
    add('queued', acc.segments[i].ended, acc.segments[i + 1].started);
  if (e.state === 'queued' && e.failovers?.length) add('queued', e.failovers.at(-1).at, end);
  const markers = [{ at: started, kind: 'model' }, ...acc.markers]
    .filter((m) => m.at >= started && m.at <= end)
    .sort((a, b) => a.at.localeCompare(b.at));
  for (let i = 0; i < markers.length; i += 1) add(markers[i].kind, markers[i].at, markers[i + 1]?.at ?? end);
  if (e.state === 'blocked')
    add('blocked', e.blockedEventAt ?? e.turnStarted ?? started, end, { label: e.error ?? null });
  for (const span of acc.spans) {
    const { start, end: finish, ...extra } = span;
    add(span.kind, start < started ? started : start, finish > end ? end : finish, extra);
  }
  for (const call of acc.pending.values())
    add(call.background ? 'background' : 'tool', call.at, end, {
      tool: call.name,
      category: call.shell.length ? primaryCategory(call.shell) : null,
      label: call.label,
    });
  const backgrounds = intervals.filter((v) => v.kind === 'background');
  const boundaries = new Map();
  for (const interval of intervals) {
    if (!boundaries.has(interval.start)) boundaries.set(interval.start, { add: [], remove: [] });
    if (!boundaries.has(interval.end)) boundaries.set(interval.end, { add: [], remove: [] });
    boundaries.get(interval.start).add.push(interval);
    boundaries.get(interval.end).remove.push(interval);
  }
  const times = [...boundaries.keys()].sort();
  const active = new Set();
  const result = [];
  const priority = { queued: 6, blocked: 5, tool: 4, model: 3, background: 2, idle: 1 };
  for (let i = 0; i < times.length - 1; i += 1) {
    const at = times[i];
    const changes = boundaries.get(at);
    for (const v of changes.remove) active.delete(v);
    for (const v of changes.add) active.add(v);
    const current = [...active].sort((a, b) => priority[b.kind] - priority[a.kind])[0];
    if (!current || current.kind === 'background') continue;
    const item = { ...current, start: at, end: times[i + 1] };
    const previous = result.at(-1);
    if (previous && previous.kind === item.kind && previous.label === item.label && previous.end === at)
      previous.end = item.end;
    else result.push(item);
  }
  return [...result, ...backgrounds].sort((a, b) => a.start.localeCompare(b.start));
}

export function snapshotAgent(acc, { now = new Date().toISOString(), live = false } = {}) {
  const e = acc.entry;
  const end = lifeEnd(acc, now, live);
  const timeline = timelineFor(acc, end);
  const time = Object.fromEntries(
    KINDS.map((kind) => [
      kind,
      Math.round(timeline.filter((v) => v.kind === kind).reduce((n, v) => n + seconds(v.start, v.end), 0)),
    ]),
  );
  const sources = [...acc.sources.values()];
  const tokens = zeroTokens();
  for (const source of sources) for (const key of Object.keys(tokens)) tokens[key] += source.tokens[key];
  const missing = acc.segments.some((s) => !s.transcript);
  const knownCosts = sources.filter((s) => s.usd !== null);
  const exact = sources.length > 0 && !missing && sources.every((s) => s.costExact);
  const ended = ACTIVE.includes(e.state) ? null : end;
  const done = !ACTIVE.includes(e.state);
  const current = timeline
    .filter((v) => v.end === end)
    .sort(
      (a, b) =>
        ({ blocked: 6, tool: 5, background: 4, queued: 3, model: 2, idle: 1 })[b.kind] -
        { blocked: 6, tool: 5, background: 4, queued: 3, model: 2, idle: 1 }[a.kind],
    )[0];
  const task = e.taskTitle ?? e.task ?? e.id;
  return {
    id: e.id,
    task:
      task
        .split(/\r?\n/)
        .find((v) => v.trim())
        ?.replace(/^#+\s*/, '') ?? e.id,
    tier: e.tier ?? null,
    mode: e.mode ?? 'read',
    provider: e.provider ?? null,
    model: e.model ?? null,
    state: e.state,
    activity: live
      ? {
          kind: done
            ? 'done'
            : e.state === 'blocked'
              ? 'blocked'
              : e.state === 'queued'
                ? 'queued'
                : (current?.kind ?? 'model'),
          label: done ? null : (current?.label ?? null),
          since: done ? end : (current?.start ?? e.started ?? e.queued ?? now),
        }
      : null,
    worktree: e.worktree ?? null,
    branch: e.branch ?? null,
    base: e.base ?? null,
    scope: e.scope ?? [],
    queued: e.queued ?? acc.firstAt ?? now,
    started: e.started ?? null,
    ended,
    rounds: e.round ?? 1,
    segments: acc.segments.map(({ provider, model, transcript, started, ended }) => ({
      provider,
      model,
      transcript,
      started,
      ended,
    })),
    cost: { usd: knownCosts.length ? knownCosts.reduce((n, s) => n + s.usd, 0) : null, exact, quotaPercent: null },
    tokens: { ...tokens, exact: sources.length > 0 && !missing && sources.every((s) => s.exact) },
    context: {
      ...acc.context,
      series: acc.context.series.map((p) => ({ ...p })).sort((a, b) => a.at.localeCompare(b.at)),
    },
    time,
    tools: [...acc.tools].map(([name, v]) => ({ name, ...v, seconds: Math.round(v.seconds) })),
    shell: [...acc.shell].map(([category, v]) => ({ category, ...v, seconds: Math.round(v.seconds) })),
    timeline,
    prompts: [...acc.prompts].sort(),
    files: {
      read: [...acc.read].map(([path, count]) => ({ path, count })),
      written: [...acc.written].map(([path, count]) => ({ path, count })),
    },
    diff: e.telemetryDiff ?? null,
    errors: acc.errors,
  };
}

function contextGrowth(point, previous, window) {
  const jump = previous ? point.size - previous.size : 0;
  if (!(window && point.size > window * 0.7) && jump <= 50000) return null;
  const cause = point.cause ?? (point.own ? 'model output and request context' : 'request context');
  const reason =
    jump > 50000
      ? `Context jumped by ${jump} tokens`
      : `Context passed 70% of its ${window}-token window (${point.size} tokens)`;
  return { at: point.at, message: `${reason} after ${cause}`, impact: point.size };
}

function addCluster(clusters, failure, agent) {
  if (failure.signature === 'Command failed') return;
  if (!clusters.has(failure.signature)) {
    clusters.set(failure.signature, { signature: failure.signature, family: failure.family, count: 0, agents: [] });
  }
  const cluster = clusters.get(failure.signature);
  cluster.count += failure.count;
  cluster.agents.push({ id: agent.id, at: failure.at, recovery: failure.recovery });
}

export function foldRun({
  anchor,
  ledger,
  accumulators,
  config = {},
  now = new Date().toISOString(),
  live = false,
  quota = [],
  lastEvent = null,
}) {
  const agents = accumulators.map((acc) => snapshotAgent(acc, { now, live }));
  const files = new Map();
  const clusters = new Map();
  const flags = [];
  const churn = [];
  const impacts = new Map();
  const readTokens = new Map();
  const flag = (kind, severity, agent, at, message, impact = 0) => {
    const item = { kind, severity, agent, at: at ?? null, message };
    flags.push(item);
    impacts.set(item, impact);
  };
  for (let i = 0; i < agents.length; i += 1) {
    const agent = agents[i];
    const acc = accumulators[i];
    for (const operation of ['read', 'written'])
      for (const file of agent.files[operation]) {
        if (!files.has(file.path)) files.set(file.path, { path: file.path, agents: {} });
        const record = files.get(file.path);
        record.agents[agent.id] ??= { reads: 0, writes: 0 };
        record.agents[agent.id][operation === 'read' ? 'reads' : 'writes'] += file.count;
        if (operation === 'written' && file.count >= 5) churn.push({ agent: agent.id, ...file });
      }
    for (const [file, tokens] of acc.readTokens) count(readTokens, file, tokens);
    const families = new Map();
    for (const failure of acc.failures.values()) {
      addCluster(clusters, failure, agent);
      if (!families.has(failure.family)) families.set(failure.family, { count: 0, at: failure.at });
      families.get(failure.family).count += failure.count;
    }
    for (const [family, failure] of families)
      if (failure.count >= 3)
        flag('fix_loop', 'warn', agent.id, failure.at, `${family} failed ${failure.count} times`, failure.count);
    if (agent.time.idle >= (config.idle_nudge_seconds ?? 30))
      flag(
        'idle',
        'info',
        agent.id,
        agent.timeline.find((v) => v.kind === 'idle')?.start,
        `${agent.time.idle}s waiting on the orchestrator`,
        agent.time.idle,
      );
    for (const at of acc.compactions) flag('compaction', 'info', agent.id, at, 'Context compacted');
    const growth = acc.growth;
    if (growth) flag('context_growth', 'warn', agent.id, growth.at, growth.message, growth.impact);
    if (agent.state === 'blocked' || acc.denied.length)
      flag(
        'permission_block',
        'warn',
        agent.id,
        acc.denied[0] ?? acc.entry.blockedEventAt ?? null,
        agent.state === 'blocked' ? (acc.entry.error ?? 'Agent is blocked') : `${acc.denied.length} tool calls denied`,
      );
  }
  const duplicateReads = [];
  for (const file of files.values()) {
    const reads = Object.values(file.agents).filter((v) => v.reads).length;
    const writes = Object.values(file.agents).filter((v) => v.writes).length;
    if (reads >= 3) duplicateReads.push({ path: file.path, reads, tokens: readTokens.get(file.path) ?? 0 });
    if (writes > 1) flag('overlapping_writes', 'warn', null, null, `${file.path} written by ${writes} agents`, writes);
  }
  duplicateReads.sort((a, b) => b.reads - a.reads || b.tokens - a.tokens || a.path.localeCompare(b.path));
  for (const file of duplicateReads.slice(0, 10)) {
    flag(
      'duplicate_reads',
      'info',
      null,
      null,
      `${file.path} read by ${file.reads} agents`,
      file.reads + file.tokens / (file.tokens + 1),
    );
  }
  churn.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path) || a.agent.localeCompare(b.agent));
  for (const file of churn.slice(0, 10)) {
    flag('edit_churn', 'warn', file.agent, null, `${file.path} was written ${file.count} times`, file.count);
  }
  const errorClusters = [...clusters.values()].sort(
    (a, b) => b.agents.length - a.agents.length || b.count - a.count || a.signature.localeCompare(b.signature),
  );
  for (const cluster of errorClusters)
    if (cluster.agents.length > 1)
      flag(
        'shared_error',
        'warn',
        null,
        cluster.agents[0].at,
        `${cluster.agents.length} agents: ${cluster.signature}`,
        cluster.agents.length,
      );
  const severity = { error: 3, warn: 2, info: 1 };
  flags.sort((a, b) => severity[b.severity] - severity[a.severity] || impacts.get(b) - impacts.get(a));
  const start = agents.map((a) => a.queued).sort()[0] ?? now;
  const end = live
    ? now
    : ([lastEvent, ...accumulators.map((a) => a.lastAt), ...agents.map((a) => a.ended ?? a.started ?? a.queued)]
        .filter(Boolean)
        .sort()
        .at(-1) ?? now);
  const knownCosts = agents.filter((a) => a.cost.usd !== null);
  const tokens = zeroTokens();
  for (const agent of agents) for (const key of Object.keys(tokens)) tokens[key] += agent.tokens[key];
  return {
    version: 1,
    session: typeof anchor === 'string' ? anchor : (anchor?.pane ?? ledger?.anchor?.pane ?? ''),
    repo: ledger?.agents?.find((a) => a.repo)?.repo ?? null,
    live,
    generatedAt: now,
    window: { start, end },
    totals: {
      agents: agents.length,
      toolCalls: agents.reduce((n, a) => n + a.tools.reduce((m, t) => m + t.count, 0), 0),
      errors: agents.reduce((n, a) => n + a.errors, 0),
      wallSeconds: Math.round(seconds(start, end)),
      costUsd: knownCosts.length ? knownCosts.reduce((n, a) => n + a.cost.usd, 0) : null,
      costExact: agents.length > 0 && agents.every((a) => a.cost.exact),
      tokens,
    },
    quota,
    agents,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    errorClusters,
    flags,
  };
}

export function foldEvents(entry, events, options = {}) {
  const acc = createAgent(entry, options.segments ?? []);
  for (const event of events) foldEvent(acc, event, options);
  return snapshotAgent(acc, options);
}
