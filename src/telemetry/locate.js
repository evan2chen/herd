import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizePath } from './shell.js';

export function pathKey(value) {
  const normalized = normalizePath(value);
  return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export async function readJsonLines(file, offset, consume) {
  let committed = offset;
  let position = offset;
  let chunks = [];
  const size = fs.statSync(file).size;
  if (offset >= size) return offset;
  const stream = fs.createReadStream(file, { start: offset, end: size - 1, highWaterMark: 256 * 1024 });
  for await (const chunk of stream) {
    let start = 0;
    for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, start)) {
      chunks.push(chunk.subarray(start, i));
      const line = chunks.length === 1 ? chunks[0].toString('utf8') : Buffer.concat(chunks).toString('utf8');
      chunks = [];
      committed = position + i + 1;
      start = i + 1;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      consume(record);
    }
    if (start < chunk.length) chunks.push(chunk.subarray(start));
    position += chunk.length;
  }
  return committed;
}

function entries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function header(file, firstOnly = false) {
  let text = '';
  const stream = fs.createReadStream(file, { end: 256 * 1024 - 1, highWaterMark: 8192 });
  try {
    for await (const chunk of stream) {
      text += chunk.toString('utf8');
      let end;
      while ((end = text.indexOf('\n')) !== -1) {
        const line = text.slice(0, end);
        text = text.slice(end + 1);
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          if (firstOnly) return null;
          continue;
        }
        const cwd = r.payload?.cwd ?? r.cwd;
        if (cwd) return { cwd, started: r.payload?.timestamp ?? r.timestamp ?? null, model: r.payload?.model ?? null };
        if (firstOnly) return null;
      }
    }
  } catch {}
  return null;
}

export async function createLocator(
  agents,
  { home = os.homedir(), now = new Date().toISOString(), cache = new Map() } = {},
) {
  const targets = new Map(agents.map((agent) => [pathKey(agent.cwd ?? agent.worktree), agent]));
  const candidates = [];
  for (const provider of ['claude', 'cursor']) {
    const root = path.join(home, `.${provider}`, 'projects');
    for (const dir of entries(root).filter((v) => v.isDirectory())) {
      const matches = [...targets].filter(([cwd]) => {
        const slug = provider === 'claude' ? cwd.replace(/[^a-z0-9]/gi, '-') : cwd.replace(/[:/\\.]+/g, '-');
        return dir.name.toLowerCase() === slug.toLowerCase();
      });
      if (!matches.length) continue;
      let files;
      if (provider === 'claude')
        files = entries(path.join(root, dir.name))
          .filter((v) => v.name.endsWith('.jsonl'))
          .map((v) => path.join(root, dir.name, v.name));
      else {
        const transcripts = path.join(root, dir.name, 'agent-transcripts');
        files = entries(transcripts).flatMap((v) =>
          v.isDirectory()
            ? entries(path.join(transcripts, v.name))
                .filter((f) => f.name.endsWith('.jsonl'))
                .map((f) => path.join(transcripts, v.name, f.name))
            : v.name.endsWith('.jsonl')
              ? [path.join(transcripts, v.name)]
              : [],
        );
      }
      for (const file of files) {
        if (!cache.has(file) && provider === 'claude') {
          const info = await header(file);
          if (info) cache.set(file, info);
        }
        const info = cache.get(file);
        const key = info?.cwd ? pathKey(info.cwd) : matches[0][0];
        if (targets.has(key))
          candidates.push({
            provider,
            transcript: file,
            ...info,
            cwd: key,
            started: info?.started ?? targets.get(key).started ?? targets.get(key).queued,
          });
      }
    }
  }
  const dates = new Set();
  for (const agent of agents) {
    if (agent.provider !== 'codex' && !agent.failovers?.some((v) => v.from.startsWith('codex/'))) continue;
    const start = Date.parse(agent.queued ?? agent.started);
    const end = Date.parse(agent.reaped ?? agent.closedAt ?? agent.reportedAt ?? now);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    for (let day = start - 86400000; day <= end + 86400000; day += 86400000)
      dates.add(new Date(day).toISOString().slice(0, 10).replaceAll('-', '/'));
  }
  for (const date of dates) {
    const dir = path.join(home, '.codex', 'sessions', date);
    for (const entry of entries(dir).filter((v) => v.name.endsWith('.jsonl'))) {
      const transcript = path.join(dir, entry.name);
      if (!cache.has(transcript)) {
        const info = await header(transcript, true);
        if (info) cache.set(transcript, info);
      }
      const info = cache.get(transcript);
      if (info && targets.has(pathKey(info.cwd)))
        candidates.push({ provider: 'codex', transcript, ...info, cwd: pathKey(info.cwd) });
    }
  }
  return { candidates };
}

export async function locateAgent(agent, options = {}) {
  const locator = options.locator ?? (await createLocator([agent], options));
  const start = agent.queued ?? agent.started ?? options.now ?? new Date().toISOString();
  const finish = agent.reaped ?? agent.closedAt ?? agent.reportedAt ?? options.now ?? new Date().toISOString();
  const history = [
    ...(agent.failovers ?? []).map((f, i, list) => {
      const [provider, ...model] = f.from.split('/');
      return { provider, model: model.join('/'), started: i ? list[i - 1].at : start, ended: f.at };
    }),
    {
      provider: agent.provider ?? null,
      model: agent.model ?? null,
      started: agent.failovers?.at(-1)?.at ?? agent.started ?? start,
      ended: agent.reportedAt ?? agent.closedAt ?? null,
    },
  ];
  const found = locator.candidates.filter(
    (c) => c.cwd === pathKey(agent.cwd ?? agent.worktree) && c.started >= start && c.started <= finish,
  );
  const segments = [];
  for (const segment of history) {
    const files = found
      .filter(
        (c) =>
          c.provider === segment.provider &&
          c.started >= segment.started &&
          (!segment.ended || c.started <= segment.ended),
      )
      .sort((a, b) => a.started.localeCompare(b.started));
    if (!files.length) segments.push({ ...segment, transcript: null });
    for (let i = 0; i < files.length; i += 1) {
      const c = files[i];
      segments.push({
        provider: c.provider,
        model: c.model ?? segment.model,
        transcript: c.transcript,
        started: c.started,
        ended: files[i + 1]?.started ?? segment.ended,
      });
      if (c.provider === 'claude') {
        const dir = path.join(path.dirname(c.transcript), path.basename(c.transcript, '.jsonl'), 'subagents');
        for (const sub of entries(dir).filter((v) => v.name.endsWith('.jsonl')))
          segments.push({
            provider: 'claude',
            model: segment.model,
            transcript: path.join(dir, sub.name),
            started: c.started,
            ended: segment.ended,
            subagent: true,
          });
      }
    }
  }
  return segments.sort((a, b) => a.started.localeCompare(b.started));
}

export const locate = locateAgent;
