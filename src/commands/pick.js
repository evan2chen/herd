import { loadConfig } from '../config.js';
import { EXIT, HerdError } from '../errors.js';
import { print } from '../output.js';
import { selectProvider } from '../routing.js';

export const summary = 'Choose the provider and model for a tier from live quota';
export const usage = 'herd pick --tier <deep|standard|fast> [--avoid <provider>]...';
export const options = {
  tier: { type: 'string' },
  avoid: { type: 'string', multiple: true },
};

export function run(values) {
  if (!values.tier) throw new HerdError('usage', '--tier is required', { exitCode: EXIT.usage, help: [usage] });
  const choice = selectProvider(loadConfig(), values.tier, { avoid: values.avoid ?? [] });
  const { eligible, ineligible } = choice.ranking;
  print({
    provider: choice.provider,
    model: choice.model,
    tier: values.tier,
    percent: choice.percent,
    spendPriority: choice.spendPriority,
    alternatives: eligible.slice(1).map(({ provider, model, percent, spendPriority }) => ({ provider, model, percent, spendPriority })),
    ineligible: ineligible.map(({ provider, reason, percent, resetsAt }) => ({ provider, reason, percent, resetsAt })),
  });
}
