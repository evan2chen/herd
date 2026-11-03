import { tierModels } from './config.js';
import { EXIT, HerdError } from './errors.js';
import { rankProviders } from './pick.js';
import { activeLimits } from './provider-state.js';
import { readQuota } from './quota.js';

export function selectProvider(config, tier, { provider, avoid = [] } = {}) {
  const models = tierModels(config, tier);
  if (provider) {
    if (!models[provider]) {
      throw new HerdError('unknown_provider', `tier ${tier} has no model for provider ${provider}`, {
        exitCode: EXIT.usage,
        help: [`Providers for ${tier}: ${Object.keys(models).join(', ')}`],
      });
    }
    return { provider, model: models[provider].model, forced: true };
  }
  const ranking = rankProviders(readQuota(config), models, { cutoff: config.cutoff_percent, avoid, limited: activeLimits() });
  if (!ranking.eligible.length) {
    throw new HerdError('no_provider', `no provider is available with ${config.cutoff_percent}% or more quota for tier ${tier}`, {
      exitCode: EXIT.noProvider,
      details: {
        earliestReset: ranking.earliestReset,
        ineligible: ranking.ineligible.map(({ provider: name, reason, percent, resetsAt }) => ({ provider: name, reason, percent, resetsAt })),
      },
    });
  }
  return { ...ranking.eligible[0], forced: false, ranking };
}
