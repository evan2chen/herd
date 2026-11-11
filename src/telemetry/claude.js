import { readJsonLines, pathKey } from './locate.js';
import { analyzeShell, errorSignature, errorFamily, filePath, hasErrorOutput, primaryCategory } from './shell.js';

export function textContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value.map((v) => (typeof v === 'string' ? v : (v.text ?? textContent(v.content)))).join('\n');
  if (value?.content) return textContent(value.content);
  return value && typeof value === 'object' ? JSON.stringify(value) : '';
}

export function toolEvent(id, name, input, at, options = {}) {
  options = { ...options, cwd: input.workdir ?? options.cwd };
  const command = input.command ?? input.cmd ?? null;
  const shell = command ? analyzeShell(command, options) : [];
  const rawPath = input.file_path ?? input.path ?? input.target_file;
  const file = rawPath ? filePath(rawPath, options.worktree, options.cwd) : null;
  const edit = /(?:write|edit|patch|delete)/i.test(name);
  const read = /(?:read|view)/i.test(name);
  const saved = rawPath ? options.saved?.[pathKey(rawPath)] : null;
  const files = { read: shell.flatMap((s) => s.read), written: shell.flatMap((s) => s.written) };
  if (file && read && !saved) files.read.push(file);
  if (file && edit) files.written.push(file);
  const patch = input.patch ?? input.patch_text;
  if (patch)
    for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      const p = filePath(match[1], options.worktree, options.cwd);
      if (p) files.written.push(p);
    }
  return {
    type: 'tool_start',
    id,
    at,
    name,
    shell,
    label:
      saved ??
      (command
        ? `${name}:${primaryCategory(shell)} ${command}`
        : `${name}${rawPath ? ` ${file ?? rawPath}` : ''}`
      ).slice(0, 300),
    files: { read: [...new Set(files.read)], written: [...new Set(files.written)] },
    background: input.run_in_background === true,
    rawPath: rawPath ? pathKey(rawPath) : null,
  };
}

export function resultEvent(id, at, output, error = false, seconds = null) {
  error ||= hasErrorOutput(output);
  const signature = error ? errorSignature(output) : null;
  return {
    type: 'tool_end',
    id,
    at,
    error,
    signature,
    family: signature ? errorFamily(signature) : null,
    denied: error && /permission|denied|not allowed|rejected|approval/i.test(output),
    seconds,
  };
}

function remember(map, key, value, limit = 256) {
  map[key] = value;
  if (Object.keys(map).length > limit) delete map[Object.keys(map)[0]];
}

export async function parseClaude(file, { offset = 0, state = {}, onEvent, ...options } = {}) {
  const events = [];
  const emit = (event) => {
    if (onEvent) onEvent(event);
    else events.push(event);
  };
  state.messages ??= {};
  state.pending ??= {};
  state.saved ??= {};
  state.requests ??= {};
  const next = await readJsonLines(file, offset, (r) => {
    const at = r.timestamp ?? state.at ?? null;
    if (r.timestamp) state.at = r.timestamp;
    if (r.type === 'cost-state') {
      const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const usage of Object.values(r.modelUsage ?? {})) {
        tokens.input += usage.inputTokens ?? 0;
        tokens.output += usage.outputTokens ?? 0;
        tokens.cacheRead += usage.cacheReadInputTokens ?? 0;
        tokens.cacheWrite += usage.cacheCreationInputTokens ?? 0;
      }
      emit({
        type: 'cost',
        at,
        usd: r.totalCostUSD ?? null,
        exact: !r.hasUnknownModelCost,
        tokens: r.modelUsage ? tokens : null,
      });
    }
    if (r.type === 'assistant') {
      const message = r.message ?? {};
      const usage = message.usage;
      if (usage) {
        const id = message.id ?? r.requestId ?? r.uuid;
        const tokens = {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheWrite: usage.cache_creation_input_tokens ?? 0,
        };
        const previous = state.messages[id] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        const delta = Object.fromEntries(Object.keys(tokens).map((k) => [k, Math.max(0, tokens[k] - previous[k])]));
        remember(state.messages, id, tokens);
        emit({ type: 'usage', at, tokens: delta, exact: true, model: message.model });
        const request = r.requestId ?? id;
        if (!state.requests[request]) {
          remember(state.requests, request, true);
          emit({
            type: 'context',
            at,
            id: request,
            size: tokens.input + tokens.cacheRead + tokens.cacheWrite,
            output: tokens.output,
            window: null,
          });
        } else emit({ type: 'request_output', at, id: request, output: tokens.output });
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type !== 'tool_use' || state.pending[block.id]) continue;
        const event = toolEvent(block.id, block.name, block.input ?? {}, at, { ...options, saved: state.saved });
        state.pending[block.id] = { background: event.background, label: event.label };
        emit(event);
      }
      if (message.stop_reason === 'end_turn') emit({ type: 'turn_end', at });
    }
    if (r.type === 'user') {
      const content = r.message?.content;
      const results = Array.isArray(content) ? content.filter((b) => b.type === 'tool_result') : [];
      if (
        !results.length &&
        !r.isMeta &&
        !r.isCompactSummary &&
        (r.origin?.kind === 'human' ||
          r.promptSource === 'typed' ||
          r.turnOrigin === 'human' ||
          typeof content === 'string') &&
        !/<task-notification>|<system-reminder>/.test(textContent(content))
      )
        emit({ type: 'prompt', at });
      for (const block of results) {
        const id = block.tool_use_id;
        const pending = state.pending[id];
        const result = r.toolUseResult ?? {};
        const output = textContent(block.content);
        const saved = result.persistedOutputPath ?? output.match(/Full output saved to:\s*([^\r\n]+)/)?.[1];
        if (saved && pending) remember(state.saved, pathKey(saved), pending.label, 2048);
        for (const changed of result.bashEditDiff?.files ?? []) {
          const p = filePath(changed.filePath, options.worktree);
          if (p) emit({ type: 'file', at, path: p, operation: 'written' });
        }
        if (pending?.background && !block.is_error) continue;
        emit(resultEvent(id, at, output, block.is_error === true || result.exitCode > 0));
        delete state.pending[id];
      }
    }
    if (r.type === 'queue-operation' || r.type === 'attachment' || r.type === 'user') {
      const content =
        r.type === 'user' ? textContent(r.message?.content) : textContent(r.content ?? r.attachment ?? r.data);
      for (const notification of content.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
        const id = notification[1].match(/<tool-use-id>(.*?)<\/tool-use-id>/)?.[1];
        if (id && state.pending[id]) {
          emit(
            resultEvent(
              id,
              at,
              notification[1],
              /<status>(?:failed|error)<\/status>|<exit-code>[1-9]/.test(notification[1]),
            ),
          );
          delete state.pending[id];
        }
      }
    }
    if (r.type === 'system' && r.subtype === 'turn_duration') emit({ type: 'turn_end', at });
    if (r.type === 'system' && /compact/.test(r.subtype ?? '')) emit({ type: 'compaction', at });
  });
  return { events, offset: next, state };
}

export const parseTranscript = parseClaude;
export default parseClaude;
