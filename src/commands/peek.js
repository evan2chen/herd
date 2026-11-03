import { anchorContext } from '../context.js';
import { EXIT, HerdError } from '../errors.js';
import * as herdr from '../herdr.js';
import { findAgent, readLedger } from '../ledger.js';
import { printText } from '../output.js';

export const summary = 'Show the last non-blank lines of an agent\'s terminal for diagnosis';
export const usage = 'herd peek <id> [--lines <n>]';
export const options = {
  lines: { type: 'string', short: 'n', default: '20' },
};

const SCROLLBACK_FACTOR = 5;
const MIN_SCROLLBACK = 200;
const ANSI =/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

function readScreen(id, lines) {
  try {
    return herdr.agentRead(id, { source: 'recent-unwrapped', lines: Math.max(lines * SCROLLBACK_FACTOR, MIN_SCROLLBACK) });
  } catch (err) {
    if (err.code !== 'agent_not_idle') throw err;
    return herdr.agentRead(id, { source: 'visible', lines: MIN_SCROLLBACK });
  }
}

export async function run(values, [id]) {
  const lines = Number.parseInt(values.lines, 10);
  if (!id || !Number.isInteger(lines) || lines < 1) {
    throw new HerdError('usage', 'an agent id and a positive --lines value are required', { exitCode: EXIT.usage, help: [usage] });
  }
  findAgent(await readLedger(anchorContext()), id);
  const rows = readScreen(id, lines)
    .replace(ANSI, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line, index, all) => line || (index > 0 && all[index - 1]));
  printText(rows.slice(-lines).join('\n').trim());
}
