import fs from 'node:fs';
import path from 'node:path';
import { sessionDir, herdHome, quotaCachePath } from '../paths.js';
import { repoSettings } from '../config.js';
import { run } from '../exec.js';
import { createLocator, locateAgent, readJsonLines } from './locate.js';
import { parseClaude } from './claude.js';
import { parseCodex } from './codex.js';
import { parseCursor } from './cursor.js';
import { createAgent, foldEvent, foldRun } from './fold.js';

const parsers = { claude: parseClaude, codex: parseCodex, cursor: parseCursor };
const stamp = (file) => { try { const s = fs.statSync(file); return `${s.size}:${s.mtimeMs}`; } catch { return null; } };
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

function title(entry) {
  if (!entry.task) return entry.id;
  try {
    const fd = fs.openSync(entry.task, 'r'), buffer = Buffer.alloc(4096);
    let count;
    try { count = fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
    const text = buffer.subarray(0, count).toString('utf8');
    return text.match(/^#\s+(?!Task h\d)(.+)$/m)?.[1] ?? text.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? text.split(/\r?\n/).find((v) => v.trim()) ?? entry.id;
  } catch { return /[\\/]|\.md$/.test(entry.task) ? entry.id : entry.task; }
}

function diff(entry) {
  if (!entry.worktree || !entry.base || !fs.existsSync(entry.worktree)) return null;
  try {
    const git = (args) => {
      const result = run('git', ['-C', entry.worktree, ...args]);
      if (result.status !== 0) throw new Error('git diff unavailable');
      return result.stdout;
    };
    const excluded = entry.generated ?? [];
    const files = git(['diff', '--numstat', '-z', '--no-renames', entry.base]).split('\0').filter(Boolean).map((line) => {
      const [added, removed, ...name] = line.split('\t');
      return { file: name.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0 };
    }).filter((f) => !excluded.includes(f.file));
    for (const file of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter((f) => f && !excluded.includes(f))) {
      const fd = fs.openSync(path.join(entry.worktree, file), 'r'), buffer = Buffer.alloc(65536);
      let added = 0, last = 10, size = 0;
      try {
        let count;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) {
          const bytes = buffer.subarray(0, count);
          if (bytes.includes(0)) { added = 0; size = 0; break; }
          for (const byte of bytes) if (byte === 10) added += 1;
          last = bytes[count - 1]; size += count;
        }
      } finally { fs.closeSync(fd); }
      files.push({ file, added: added + Number(size > 0 && last !== 10), removed: 0 });
    }
    return {
      files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0),
      outOfScope: files.filter((f) => entry.mode === 'read' || entry.scope?.length && !entry.scope.some((glob) => path.matchesGlob(f.file, glob))).map((f) => f.file),
    };
  } catch { return null; }
}

function quotaSnapshot(cache, at, runStart, providers) {
  const data = cache?.data ?? cache;
  const sampled = data?.generatedAt ?? (cache?.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null);
  return providers.map((provider) => {
    const p = sampled && sampled >= runStart && sampled <= at ? data.providers?.find((v) => v.provider === provider) : null;
    return { provider, startPercent: null, endPercent: p?.quotaSemantics?.effectiveAvailability?.find((s) => s.scope === 'all_models')?.effectivePercentRemaining ?? null };
  });
}

function runtime({ anchor, config = {}, live = false, home, now }) {
  const agents = new Map(), tails = new Map(), headers = new Map();
  const usageFile = path.join(herdHome(), 'usage.jsonl');
  let usageOffset = 0, usageStamp = null, lastSignature = null, lastEvent = null;
  const lifecycle = new Map();
  async function refresh(ledger, instant = new Date().toISOString()) {
    instant = instant instanceof Date ? instant.toISOString() : typeof instant === 'number' ? new Date(instant).toISOString() : instant;
    const pane = typeof anchor === 'string' ? anchor : anchor?.pane ?? ledger.anchor?.pane;
    const usageChanged = stamp(usageFile);
    if (usageChanged !== usageStamp && usageChanged !== null) {
      if (fs.statSync(usageFile).size < usageOffset) { usageOffset = 0; lifecycle.clear(); lastEvent = null; }
      usageOffset = await readJsonLines(usageFile, usageOffset, (record) => {
        if (record.session !== pane) return;
        if (!lastEvent || record.at > lastEvent) lastEvent = record.at;
        if (!lifecycle.has(record.id)) lifecycle.set(record.id, []);
        if (['reported', 'exited', 'rate_limited', 'failover'].includes(record.event)) lifecycle.get(record.id).push(record);
      });
      usageStamp = usageChanged;
    }
    const locator = await createLocator(ledger.agents, { home, now: instant, cache: headers });
    let changed = false;
    const present = new Set(ledger.agents.map((e) => e.id));
    for (const id of agents.keys()) if (!present.has(id)) { agents.delete(id); changed = true; }
    for (const entry of ledger.agents) {
      const segments = await locateAgent(entry, { locator, now: instant });
      let acc = agents.get(entry.id);
      const truncated = segments.some((s) => s.transcript && tails.has(s.transcript) && fs.existsSync(s.transcript) && fs.statSync(s.transcript).size < tails.get(s.transcript).offset);
      const removed = acc?.segments.some((s) => s.transcript && !segments.some((v) => v.transcript === s.transcript));
      if (!acc || truncated || removed) {
        acc = createAgent(entry, segments);
        agents.set(entry.id, acc);
        for (const segment of segments) if (segment.transcript) tails.delete(segment.transcript);
        changed = true;
      }
      acc.segments = segments;
      acc.entry = { ...entry, taskTitle: acc.entry.taskTitle ?? title(entry) };
      const settings = entry.repo ? repoSettings({ repos: {}, ...config }, entry.repo) : { verify: [], commands: {} };
      for (const segment of segments) {
        const file = segment.transcript, parser = parsers[segment.provider];
        if (!file || !parser || !fs.existsSync(file)) continue;
        let tail = tails.get(file) ?? { offset: 0, state: {}, stamp: null };
        const signature = stamp(file);
        if (tail.stamp === signature) continue;
        const next = await parser(file, { offset: tail.offset, state: tail.state, worktree: entry.worktree ?? entry.cwd, cwd: entry.cwd, model: segment.model, ...settings, verify: entry.verify?.length ? entry.verify : settings.verify,
          onEvent: (event) => foldEvent(acc, event, { source: file, provider: segment.provider, model: segment.model, prices: config.prices ?? {} }),
        });
        changed ||= next.offset !== tail.offset;
        tail = { ...next, stamp: signature }; delete tail.events;
        tails.set(file, tail);
      }
      const records = lifecycle.get(entry.id) ?? [];
      const count = acc.lifecycleCount ?? 0;
      for (const record of records.slice(count)) {
        if (record.event === 'reported' || record.event === 'exited') acc.markers.push({ at: record.at, kind: 'idle' });
      }
      acc.lifecycleCount = records.length;
      if (changed || !acc.diffChecked) { acc.entry.telemetryDiff = diff(entry); acc.diff = acc.entry.telemetryDiff; acc.diffChecked = true; }
      else acc.entry.telemetryDiff = acc.diff;
    }
    const signature = JSON.stringify(ledger) + usageStamp + stamp(quotaCachePath());
    if (!changed && signature === lastSignature) return null;
    lastSignature = signature;
    const start = ledger.agents.map((e) => e.queued ?? e.started).filter(Boolean).sort()[0] ?? instant;
    const end = live ? instant : [lastEvent, ...[...agents.values()].map((a) => a.entry.reportedAt ?? a.lastAt ?? a.entry.started ?? start)].filter(Boolean).sort().at(-1) ?? instant;
    const providers = [...new Set([...agents.values()].flatMap((a) => a.segments.map((s) => s.provider)).filter(Boolean))];
    return foldRun({ anchor, ledger, accumulators: [...agents.values()], config, now: instant, live, lastEvent, quota: quotaSnapshot(readJson(quotaCachePath(), null), end, start, providers) });
  }
  return { refresh, now };
}

export async function buildRun({ anchor, ledger, config = {}, now = new Date().toISOString(), home } = {}) {
  if (!ledger) ledger = readJson(path.join(sessionDir(typeof anchor === 'string' ? anchor : anchor.pane), 'ledger.json'), { anchor, agents: [] });
  return runtime({ anchor: anchor ?? ledger.anchor, config, home }).refresh(ledger, now);
}

export function createLiveRun({ anchor, config = {}, home } = {}) {
  const session = runtime({ anchor, config, live: true, home });
  const file = path.join(sessionDir(typeof anchor === 'string' ? anchor : anchor.pane), 'ledger.json');
  let inflight = null;
  return {
    refresh({ now = new Date().toISOString() } = {}) {
      if (!inflight) inflight = session.refresh(readJson(file, { anchor, agents: [] }), now).finally(() => { inflight = null; });
      return inflight;
    },
  };
}
