import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { detectRateLimit } from '../../src/ratelimit.js';

const patterns = (provider) => DEFAULT_CONFIG.adapters[provider].rate_limit_patterns;

test('detects each provider\'s limit message at the bottom of the screen', () => {
  const screens = {
    claude: 'Working on it...\n\n  ⎿  You\'ve hit your limit · resets 11pm (America/New_York)\n\n> ',
    codex: '• Ran node check.js\n\n■ You\'ve hit your usage limit. Upgrade to Pro or try again in 2 hours.\n\n› Ask Codex',
    cursor: 'Composer 2.5\n  You\'ve hit your usage limit for this model.\n  → Add a follow-up',
  };
  for (const [provider, screen] of Object.entries(screens)) {
    assert.ok(detectRateLimit(screen, patterns(provider)), provider);
  }
});

test('ignores agents discussing rate limiting in their work', () => {
  const screen = [
    '● Added a token-bucket rate limiter to src/api/limit.ts',
    '  The limiter returns 429 when a client exceeds its request budget.',
    '❯ ',
  ].join('\n');
  for (const provider of ['claude', 'codex', 'cursor']) assert.equal(detectRateLimit(screen, patterns(provider)), null, provider);
});

test('looks only at the last lines so old scrollback does not retrigger', () => {
  const screen = [`You've hit your usage limit`, ...Array.from({ length: 30 }, (_, i) => `line ${i}`)].join('\n');
  assert.equal(detectRateLimit(screen, patterns('codex')), null);
});
