import { anchorContext } from '../context.js';
import { EXIT, HerdError } from '../errors.js';
import * as herdr from '../herdr.js';
import { findAgent, readLedger } from '../ledger.js';
import { print } from '../output.js';

export const summary = 'Send key presses to an agent, such as answering a blocked dialog';
export const usage = 'herd keys <id> <key>...   (keys like enter, esc, down, y, ctrl+c)';
export const options = {};

export async function run(_values, [id, ...keys]) {
  if (!id || !keys.length) throw new HerdError('usage', 'an agent id and at least one key are required', { exitCode: EXIT.usage, help: [usage] });
  findAgent(await readLedger(anchorContext()), id);
  herdr.agentSendKeys(id, keys);
  print({ id, sent: keys });
}
