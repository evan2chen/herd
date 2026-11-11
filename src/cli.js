import { parseArgs } from 'node:util';
import * as close from './commands/close.js';
import * as collect from './commands/collect.js';
import * as diff from './commands/diff.js';
import * as discard from './commands/discard.js';
import * as doctor from './commands/doctor.js';
import * as failover from './commands/failover.js';
import * as integrate from './commands/integrate.js';
import * as keys from './commands/keys.js';
import * as list from './commands/list.js';
import * as peek from './commands/peek.js';
import * as pick from './commands/pick.js';
import * as reap from './commands/reap.js';
import * as recap from './commands/recap.js';
import * as reconcile from './commands/reconcile.js';
import * as send from './commands/send.js';
import * as spawn from './commands/spawn.js';
import * as sync from './commands/sync.js';
import * as verify from './commands/verify.js';
import * as wait from './commands/wait.js';
import * as watch from './commands/watch.js';
import { EXIT, HerdError } from './errors.js';
import { print, printError } from './output.js';

const COMMANDS = {
  pick,
  spawn,
  wait,
  collect,
  send,
  keys,
  diff,
  verify,
  integrate,
  sync,
  discard,
  failover,
  reap,
  recap,
  watch,
  reconcile,
  list,
  peek,
  close,
  doctor,
};

function usage() {
  return {
    usage: 'herd <command> [options]',
    commands: Object.entries(COMMANDS).map(([name, command]) => ({ name, summary: command.summary, usage: command.usage })),
    help: ['Run `herd <command> --help` for one command'],
  };
}

export async function main(argv) {
  const [name, ...rest] = argv;
  if (!name || ['help', '--help', '-h'].includes(name)) {
    print(usage());
    return EXIT.ok;
  }
  const command = COMMANDS[name];
  if (!command) {
    printError(new HerdError('unknown_command', `unknown command: ${name}`, { help: [`Commands: ${Object.keys(COMMANDS).join(', ')}`] }));
    return EXIT.usage;
  }
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { ...command.options, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
    });
    if (values.help) {
      print({ usage: command.usage, summary: command.summary });
      return EXIT.ok;
    }
    return (await command.run(values, positionals)) ?? EXIT.ok;
  } catch (err) {
    if (err instanceof HerdError) {
      printError(err);
      return err.exitCode;
    }
    if (err.code?.startsWith?.('ERR_PARSE_ARGS')) {
      printError(new HerdError('usage', err.message, { help: [command.usage] }));
      return EXIT.usage;
    }
    throw err;
  }
}
