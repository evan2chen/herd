import fs from 'node:fs';
import os from 'node:os';
import { TIERS, adapterFor, loadConfig, tierModels } from '../config.js';
import { anchorContext } from '../context.js';
import { EXIT } from '../errors.js';
import { run as runProcess, runShell } from '../exec.js';
import { print } from '../output.js';
import { readQuota } from '../quota.js';

export const summary = 'Check Herdr context, quota access, agent CLIs and configured model IDs';
export const usage = 'herd doctor';
export const options = {};

function attempt(check, fn) {
  try {
    return { check, ...fn() };
  } catch (err) {
    return { check, status: 'fail', detail: err.message };
  }
}

function findExecutable(name) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const { status, stdout } = runProcess(finder, [name]);
  return status === 0 ? stdout.split(/\r?\n/)[0].trim() : null;
}

function catalogModels(catalog) {
  const source = catalog.file
    ? fs.readFileSync(catalog.file.replace(/^~(?=$|[\\/])/, os.homedir()), 'utf8')
    : runShell(catalog.command, { timeoutMs: 60000 }).stdout;
  return new Set([...source.matchAll(new RegExp(catalog.pattern, 'gm'))].map((match) => match[1]));
}

export function run() {
  const config = loadConfig();
  const rows = [
    attempt('herdr', () => {
      const anchor = anchorContext();
      return { status: 'ok', detail: `pane ${anchor.pane} in tab ${anchor.tab}` };
    }),
  ];

  let quota = null;
  rows.push(attempt('quota-axi', () => {
    quota = readQuota(config);
    return { status: 'ok', detail: `${quota.providers.length} providers reported` };
  }));

  for (const provider of config.providers) {
    const adapter = adapterFor(config, provider);
    rows.push(attempt(`${provider}:quota`, () => {
      const all = quota?.providers.find((entry) => entry.provider === provider)
        ?.quotaSemantics?.effectiveAvailability?.find((entry) => entry.scope === 'all_models');
      return all?.status === 'known'
        ? { status: 'ok', detail: `${all.effectivePercentRemaining}% remaining` }
        : { status: 'fail', detail: 'no known all_models quota' };
    }));
    rows.push(attempt(`${provider}:cli`, () => {
      const found = findExecutable(adapter.executable);
      return found ? { status: 'ok', detail: found } : { status: 'fail', detail: `${adapter.executable} not on PATH` };
    }));
    rows.push(attempt(`${provider}:models`, () => {
      const configured = [...new Set(TIERS.map((tier) => tierModels(config, tier)[provider]?.model).filter(Boolean))];
      if (!adapter.model_catalog) return { status: 'skip', detail: `no catalog; using ${configured.join(', ')}` };
      const available = catalogModels(adapter.model_catalog);
      const missing = configured.filter((model) => !available.has(model));
      return missing.length
        ? { status: 'fail', detail: `not in catalog: ${missing.join(', ')}` }
        : { status: 'ok', detail: configured.join(', ') };
    }));
  }

  print({ checks: rows });
  return rows.some((row) => row.status === 'fail') ? EXIT.error : EXIT.ok;
}
