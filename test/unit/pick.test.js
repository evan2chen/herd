import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_CONFIG, tierModels } from '../../src/config.js';
import { rankProviders } from '../../src/pick.js';

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/quota.json', import.meta.url), 'utf8'));

function quotaWith(mutate) {
  const quota = structuredClone(fixture);
  mutate(Object.fromEntries(quota.providers.map((entry) => [
    entry.provider,
    Object.fromEntries(entry.quotaSemantics.effectiveAvailability.map((scope) => [scope.scope, scope])),
  ])));
  return quota;
}

function rank(quota, tier, options = {}) {
  return rankProviders(quota, tierModels(DEFAULT_CONFIG, tier), { cutoff: 10, ...options });
}

test('ranks by spendPriority with unknown treated as neutral 1.0', () => {
  const { eligible } = rank(fixture, 'standard');
  assert.deepEqual(eligible.map((entry) => entry.provider), ['claude', 'cursor', 'codex']);
  assert.equal(eligible[2].spendPriority, 1);
});

test('excludes a provider below the 10% cutoff', () => {
  const quota = quotaWith((scopes) => { scopes.claude.all_models.effectivePercentRemaining = 9; });
  const { eligible, ineligible } = rank(quota, 'standard');
  assert.deepEqual(eligible.map((entry) => entry.provider), ['cursor', 'codex']);
  assert.deepEqual(ineligible.map(({ provider, reason, percent }) => ({ provider, reason, percent })), [
    { provider: 'claude', reason: 'below_cutoff', percent: 9 },
  ]);
});

test('keeps a provider at exactly the cutoff', () => {
  const quota = quotaWith((scopes) => { scopes.claude.all_models.effectivePercentRemaining = 10; });
  assert.equal(rank(quota, 'standard').eligible[0].provider, 'claude');
});

test('applies the cutoff to a model-specific scope such as grok_bot', () => {
  const quota = quotaWith((scopes) => { scopes.cursor.grok_bot.effectivePercentRemaining = 5; });
  const deep = rank(quota, 'deep');
  assert.ok(!deep.eligible.some((entry) => entry.provider === 'cursor'));
  assert.ok(rank(quota, 'standard').eligible.some((entry) => entry.provider === 'cursor'));
});

test('honours avoided providers for cross-provider review', () => {
  const { eligible } = rank(fixture, 'deep', { avoid: ['claude'] });
  assert.ok(eligible.every((entry) => entry.provider !== 'claude'));
});

test('reports the earliest reset when every provider is below the cutoff', () => {
  const quota = quotaWith((scopes) => {
    scopes.claude.all_models.effectivePercentRemaining = 3;
    scopes.codex.all_models.effectivePercentRemaining = 4;
    scopes.cursor.all_models.effectivePercentRemaining = 5;
  });
  const result = rank(quota, 'fast');
  assert.equal(result.eligible.length, 0);
  assert.equal(result.earliestReset, '2026-10-24T23:00:00.339877+00:00');
});

test('skips a provider cooling down after a rate limit', () => {
  const until = '2026-10-24T22:00:00.000Z';
  const { eligible, ineligible } = rank(fixture, 'standard', { limited: { claude: { until, reason: 'hit limit' } } });
  assert.deepEqual(eligible.map((entry) => entry.provider), ['cursor', 'codex']);
  assert.deepEqual(ineligible.map(({ provider, reason, resetsAt }) => ({ provider, reason, resetsAt })), [{ provider: 'claude', reason: 'rate_limited', resetsAt: until }]);
});

test('treats a provider without quota data as ineligible', () => {
  const quota = structuredClone(fixture);
  quota.providers = quota.providers.filter((entry) => entry.provider !== 'codex');
  const { ineligible } = rank(quota, 'standard');
  assert.deepEqual(ineligible.map(({ provider, reason }) => ({ provider, reason })), [{ provider: 'codex', reason: 'quota_unknown' }]);
});
