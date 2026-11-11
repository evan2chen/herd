import { readJsonLines } from './locate.js';
import { toolEvent, resultEvent, textContent } from './claude.js';

function literal(value) {
  if (value[0] === '"') { try { return JSON.parse(value); } catch {} }
  return value.slice(1, -1).replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
}

function argumentsAt(input, start) {
  let depth = 1, quote = null;
  for (let i = start; i < input.length; i += 1) {
    const c = input[i];
    if (quote) { if (c === '\\') i += 1; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')' && --depth === 0) return { value: input.slice(start, i).trim(), end: i + 1 };
  }
  return { value: input.slice(start).trim(), end: input.length };
}

function fields(input) {
  try { return JSON.parse(input); } catch {}
  const result = {};
  for (const match of input.matchAll(/\b(cmd|command|path|file_path|workdir|session_id|cell_id)["']?\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\d+)/g)) result[match[1]] = /^\d+$/.test(match[2]) ? Number(match[2]) : literal(match[2]);
  return result;
}

function objects(output) {
  const results = [];
  if (output && typeof output === 'object' && !Array.isArray(output)) results.push(output);
  const text = textContent(output);
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const c = text[i];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
      else if (c === '"') quoted = true;
      else if (c === '{') depth += 1;
      else if (c === '}' && --depth === 0) {
        try { const value = JSON.parse(text.slice(start, i + 1)); if ('exit_code' in value || 'session_id' in value || 'wall_time_seconds' in value) results.push(value); } catch {}
        start = i; break;
      }
    }
  }
  return results;
}

export async function parseCodex(file, { offset = 0, state = {}, onEvent, ...options } = {}) {
  const events = [];
  const emit = (event) => { if (onEvent) onEvent(event); else events.push(event); };
  state.calls ??= {};
  state.jobs ??= {};
  state.total ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const next = await readJsonLines(file, offset, (r) => {
    const p = r.payload ?? {}, at = r.timestamp ?? null;
    if (r.type === 'turn_context' || r.type === 'session_meta') state.model = p.model ?? state.model;
    if (r.type === 'event_msg' && p.type === 'task_started') { state.window = p.model_context_window ?? state.window; emit({ type: 'prompt', at }); }
    if (r.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
      const total = p.info.total_token_usage, last = p.info.last_token_usage ?? {};
      const tokens = { input: Math.max(0, (total.input_tokens ?? 0) - (total.cached_input_tokens ?? 0)), output: total.output_tokens ?? 0, cacheRead: total.cached_input_tokens ?? 0, cacheWrite: total.cache_write_input_tokens ?? 0 };
      const delta = Object.fromEntries(Object.keys(tokens).map((key) => [key, Math.max(0, tokens[key] - state.total[key])]));
      if (Object.values(delta).some((n) => n > 0)) {
        emit({ type: 'usage', at, tokens: delta, exact: true, model: state.model ?? options.model });
        emit({ type: 'context', at, id: at, size: last.input_tokens ?? 0, output: last.output_tokens ?? 0, window: p.info.model_context_window ?? state.window ?? null });
      }
      state.total = tokens;
    }
    if (r.type === 'event_msg' && ['task_complete', 'task_completed', 'turn_aborted'].includes(p.type)) emit({ type: 'turn_end', at });
    if (r.type === 'compacted' || r.type === 'event_msg' && /compact/.test(p.type)) emit({ type: 'compaction', at });
    if (r.type !== 'response_item') return;
    if (['custom_tool_call', 'function_call'].includes(p.type)) {
      const input = p.input ?? p.arguments ?? '', name = p.name.split('.').at(-1), operations = [];
      const add = (tool, raw) => {
        const parsed = tool === 'apply_patch' ? { patch: /^['"`]/.test(raw) ? literal(raw) : raw } : fields(raw);
        const poll = parsed.session_id ?? parsed.cell_id;
        if (poll != null && state.jobs[poll]) {
          operations.push(...state.jobs[poll].map((o) => ({ ...o, poll: String(poll) })));
          return;
        }
        const event = toolEvent(`${p.call_id}:${operations.length}`, tool, parsed, at, options);
        operations.push({ id: event.id, shell: tool === 'exec_command' || tool === 'write_stdin', poll: null });
        emit(event);
      };
      if (name === 'exec') {
        const pattern = /\btools\.([\w]+)\s*\(/g;
        let match;
        while ((match = pattern.exec(input))) {
          const argument = argumentsAt(input, pattern.lastIndex);
          add(match[1], argument.value); pattern.lastIndex = argument.end;
        }
      }
      if (!operations.length) add(name, input);
      state.calls[p.call_id] = { operations };
    }
    if (['custom_tool_call_output', 'function_call_output'].includes(p.type)) {
      const pending = state.calls[p.call_id];
      if (!pending) return;
      const output = textContent(p.output), values = objects(p.output);
      const cell = output.match(/Script running with cell ID\s+(\S+)/)?.[1];
      const exit = output.match(/(?:Process exited with code|exit code)\s*:?\s*(-?\d+)/i);
      const remaining = [];
      let index = 0;
      for (const operation of pending.operations) {
        const result = operation.shell ? values[index++] : null;
        if (operation.poll) delete state.jobs[operation.poll];
        if (result?.session_id != null && result.exit_code == null) {
          state.jobs[result.session_id] = [operation];
          emit({ type: 'background', id: operation.id, at });
        } else if (cell && !result) {
          remaining.push(operation);
          emit({ type: 'background', id: operation.id, at });
        } else {
          const failed = result?.exit_code != null ? result.exit_code !== 0 : exit ? Number(exit[1]) !== 0 : /\b(?:isError|is_error)\s*["']?\s*:\s*true|(?:approval|request|command|tool).*(?:rejected|denied)|permission denied|^Error(?: executing| parsing|:)/im.test(output);
          emit(resultEvent(operation.id, at, result?.output ?? output, failed, operation.poll ? null : result?.wall_time_seconds ?? null));
        }
      }
      if (cell && remaining.length) state.jobs[cell] = remaining;
      delete state.calls[p.call_id];
    }
  });
  return { events, offset: next, state };
}

export const parseTranscript = parseCodex;
export default parseCodex;
