import { readJsonLines } from './locate.js';
import { toolEvent } from './claude.js';

export async function parseCursor(file, { offset = 0, state = {}, onEvent, ...options } = {}) {
  const events = [];
  const emit = (event) => {
    if (onEvent) onEvent(event);
    else events.push(event);
  };
  state.counter ??= 0;
  const next = await readJsonLines(file, offset, (r) => {
    for (const block of r.message?.content ?? []) {
      if (block.type !== 'tool_use') continue;
      const event = toolEvent(`cursor-${state.counter++}`, block.name, block.input ?? {}, null, options);
      emit({ ...event, untimed: true });
    }
  });
  return { events, offset: next, state };
}

export const parseTranscript = parseCursor;
export default parseCursor;
