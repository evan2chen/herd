import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderPage } from '../../src/telemetry/page.js';

const run = JSON.parse(readFileSync(new URL('../fixtures/run.json', import.meta.url), 'utf8'));

for (const live of [false, true]) {
  test(`run page renders a complete ${live ? 'live' : 'offline'} document`, () => {
    const html = renderPage(run, { live });
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.endsWith('</body></html>'));
    assert.ok(Buffer.byteLength(html) < 300_000);
    assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:src|href)="(?!data:)/i);
    if (!live) assert.doesNotMatch(html, /https?:\/\//);
    const data = html.match(/<script type="application\/json" id="herd-run">([\s\S]*?)<\/script>/)[1];
    assert.deepEqual(JSON.parse(data), run);
    assert.ok(html.includes(`data-live="${live}"`));
    for (const view of ['overview', 'agents', 'timeline', 'context', 'environments', 'errors']) {
      assert.ok(html.includes(`id="view-${view}"`));
    }
    assert.ok(html.includes("new EventSource('/events')"));
  });
}

test('embedded transcript text cannot close its script element', () => {
  const unsafe = structuredClone(run);
  unsafe.agents[0].task = '</script><script>alert("injected")</script>\u2028';
  const html = renderPage(unsafe, { live: false });
  assert.ok(!html.includes(unsafe.agents[0].task));
  const data = html.match(/id="herd-run">([\s\S]*?)<\/script>/)[1];
  assert.deepEqual(JSON.parse(data), unsafe);
});
