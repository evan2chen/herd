const NEUTRAL_SPEND_PRIORITY = 1;

function scopeOf(providerQuota, scope) {
  return providerQuota?.quotaSemantics?.effectiveAvailability?.find((entry) => entry.scope === scope);
}

function knownPercent(scope) {
  return scope?.status === 'known' && typeof scope.effectivePercentRemaining === 'number'
    ? scope.effectivePercentRemaining
    : null;
}

function earliestReset(providerQuota, scopes) {
  const windowIds = new Set(scopes.flatMap((scope) => scope?.limitingWindowIds ?? []));
  const resets = (providerQuota?.windows ?? [])
    .filter((window) => windowIds.has(window.id) && window.resetsAt)
    .map((window) => window.resetsAt)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return resets[0] ?? null;
}

function evaluate(provider, { model, quota_scope }, providerQuota, cutoff, limit) {
  const base = { provider, model, scope: quota_scope };
  if (limit) return { ...base, eligible: false, reason: 'rate_limited', percent: null, resetsAt: limit.until };
  const all = scopeOf(providerQuota, 'all_models');
  const modelScope = quota_scope === 'all_models' ? all : scopeOf(providerQuota, quota_scope);
  const percents = [knownPercent(all), knownPercent(modelScope)];
  if (percents.some((value) => value === null)) {
    return { ...base, eligible: false, reason: 'quota_unknown', percent: null, resetsAt: null };
  }
  const percent = Math.min(...percents);
  const resetsAt = earliestReset(providerQuota, [all, modelScope]);
  if (percent < cutoff) {
    return { ...base, eligible: false, reason: 'below_cutoff', percent, resetsAt };
  }
  const spendPriority = modelScope.selection?.status === 'known'
    ? modelScope.selection.spendPriority
    : NEUTRAL_SPEND_PRIORITY;
  return { ...base, eligible: true, percent, spendPriority, resetsAt };
}

export function rankProviders(quota, models, { cutoff, avoid = [], limited = {} }) {
  const order = Object.keys(models);
  const results = order
    .filter((provider) => !avoid.includes(provider))
    .map((provider) => evaluate(
      provider,
      models[provider],
      quota.providers.find((entry) => entry.provider === provider),
      cutoff,
      limited[provider],
    ));
  const eligible = results
    .filter((result) => result.eligible)
    .sort((a, b) => b.spendPriority - a.spendPriority
      || b.percent - a.percent
      || order.indexOf(a.provider) - order.indexOf(b.provider));
  const ineligible = results.filter((result) => !result.eligible);
  const resets = ineligible.map((result) => result.resetsAt).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b));
  return { eligible, ineligible, earliestReset: resets[0] ?? null };
}
