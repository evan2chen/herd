import { loadConfig, repoSettings } from '../config.js';
import { anchorContext } from '../context.js';
import { EXIT, HerdError } from '../errors.js';
import { runShell } from '../exec.js';
import { findAgent, readLedger, requireWorktree, updateAgent } from '../ledger.js';
import { print } from '../output.js';

export const summary = 'Run the repo\'s configured verify commands inside an agent\'s worktree';
export const usage = 'herd verify <id>';
export const options = {};

const TAIL_LINES = 20;

function tail(text) {
  return text.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).slice(-TAIL_LINES).join('\n');
}

export async function run(_values, [id]) {
  if (!id) throw new HerdError('usage', 'an agent id is required', { exitCode: EXIT.usage, help: [usage] });
  const config = loadConfig();
  const anchor = anchorContext();
  const entry = findAgent(await readLedger(anchor), id);
  requireWorktree(entry);
  const { verify } = repoSettings(config, entry.repo);
  if (!verify.length) {
    throw new HerdError('no_verify_commands', `no verify commands configured for ${entry.repo}`, {
      help: [`Add to config.toml: [repos."${entry.repo.replaceAll('\\', '/')}"] verify = ["npm test"]`],
    });
  }

  const commands = [];
  let failure = null;
  for (const command of verify) {
    const started = Date.now();
    const result = runShell(command, { cwd: entry.cwd, timeoutMs: config.verify_timeout_minutes * 60000 });
    commands.push({ command, exit: result.status, seconds: Math.round((Date.now() - started) / 100) / 10 });
    if (result.status !== 0 && !failure) failure = { command, tail: tail(`${result.stdout}\n${result.stderr}`) };
  }
  const outcome = failure ? 'fail' : 'pass';
  await updateAgent(anchor, id, { verified: { result: outcome, at: new Date().toISOString() } });
  print({ id, result: outcome, commands, ...(failure ? { failure } : {}) });
}
