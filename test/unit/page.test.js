import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, runInNewContext } from 'node:vm';
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

function ui(snapshot = run, live = false) {
  const html = renderPage(snapshot, { live });
  const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const startup = /bindInteractions\(\);\r?\nrender\(\);\r?\nif \(live\) connectLive\(\);/;
  const exported = source.replace(startup, `globalThis.ui = {
    state, renderers, selectedAgents, pageItems, buildFileTree, currentPaths, validSnapshot,
    bounds, zoomTimeline, panTimeline,
    update: next => { run = next; }
  };`);
  const context = {
    document: {
      body: { dataset: { live: String(live) } },
      getElementById: id => id === 'herd-run' ? { textContent: JSON.stringify(snapshot) } : {}
    }
  };
  new Script(source);
  runInNewContext(exported, context);
  return context.ui;
}

function largeRun() {
  const snapshot = structuredClone(run);
  snapshot.agents = Array.from({ length: 48 }, (_, index) => ({
    ...structuredClone(run.agents[index % run.agents.length]), id: `agent-${index + 1}`, errors: index
  }));
  snapshot.flags = Array.from({ length: 323 }, (_, index) => ({
    kind: 'duplicate_reads', severity: 'warn', message: `Repeated file ${index}`, agent: 'agent-48'
  }));
  snapshot.files = Array.from({ length: 1555 }, (_, index) => ({
    path: `src/group-${index % 10}/file-${index}.js`,
    agents: { 'agent-1': { reads: 2, writes: 1 }, 'agent-2': { reads: 1, writes: 1 } }
  }));
  return snapshot;
}

test('large views bound initial detail rendering and retain all agents through pagination', () => {
  const app = ui(largeRun());
  const overview = app.renderers.overview();
  assert.match(overview, /323 flags/);
  assert.match(overview, /data-flag-kind="duplicate_reads" aria-expanded="false"/);
  assert.doesNotMatch(overview, /class="flag"/);
  app.state.flags.add('duplicate_reads');
  assert.equal((app.renderers.overview().match(/class="flag"/g) || []).length, 12);
  app.state.flagLimits.set('duplicate_reads', 24);
  assert.equal((app.renderers.overview().match(/class="flag"/g) || []).length, 24);
  assert.equal(app.state.density, 'compact');
  assert.equal((app.renderers.agents().match(/data-key="agent-/g) || []).length, 12);
  assert.doesNotMatch(app.renderers.agents(), /class="histograms"/);
  const ids = new Set();
  for (let page = 0; page < 4; page++) {
    app.state.page = page;
    for (const agent of app.pageItems(app.selectedAgents())) ids.add(agent.id);
  }
  assert.equal(ids.size, 48);
  const timeline = app.renderers.timeline();
  assert.equal((timeline.match(/data-key="lane-name-/g) || []).length, 12);
});

test('agent filtering, numeric sorting and changing snapshots select the correct agents', () => {
  const snapshot = largeRun();
  const app = ui(snapshot, true);
  app.state.search = 'agent-48';
  assert.deepEqual(Array.from(app.selectedAgents(), agent => agent.id), ['agent-48']);
  app.state.search = '';
  app.state.provider = snapshot.agents[0].provider;
  app.state.status = snapshot.agents[0].activity.kind;
  assert.ok(app.selectedAgents().length > 0);
  assert.ok(app.selectedAgents().every(agent => agent.provider === app.state.provider));
  app.state.provider = '';
  app.state.status = '';
  app.state.sort = 'errors';
  assert.equal(app.selectedAgents()[0].id, 'agent-48');
  app.state.sort = 'id';
  assert.equal(app.selectedAgents()[1].id, 'agent-2');
  app.state.page = 3;
  app.update({ ...snapshot, agents: snapshot.agents.slice(0, 2) });
  assert.equal(app.pageItems(app.selectedAgents()).length, 2);
  assert.equal(app.state.page, 0);
  assert.equal(app.validSnapshot(snapshot), true);
  assert.equal(app.validSnapshot({ ...snapshot, files: null }), false);
  assert.equal(Boolean(app.validSnapshot(null)), false);
});

test('large file trees start collapsed, aggregate activity and filter without opening unrelated paths', () => {
  const app = ui(largeRun());
  const root = app.buildFileTree();
  assert.equal(root.files, 1555);
  assert.equal(root.reads, 4665);
  assert.equal(root.writes, 3110);
  const initial = app.renderers.environments();
  assert.equal((initial.match(/data-directory=/g) || []).length, 1);
  assert.doesNotMatch(initial, /file-1554\.js/);
  app.state.expanded.add('src');
  assert.equal((app.renderers.environments().match(/data-directory=/g) || []).length, 11);
  app.state.fileSearch = 'file-1554.js';
  assert.equal(app.buildFileTree().files, 1);
  app.state.expanded.add('src/group-4');
  assert.match(app.renderers.environments(), /file-1554\.js/);
  app.state.fileDetails.add('src/group-4/file-1554.js');
  assert.match(app.renderers.environments(), /data-inspect="agent-2"/);
  assert.equal(root.overlap, true);
});

test('deferred flag and recovery text remains escaped', () => {
  const snapshot = structuredClone(run);
  snapshot.flags = [{ kind: '<kind>', severity: 'error', message: '<img onerror=alert(1)>', agent: 'agent"' }];
  snapshot.errorClusters = [{ signature: '<script>', family: 'tool', count: 1,
    agents: [{ id: 'agent"', at: null, recovery: '<img onerror=alert(1)>' }] }];
  const app = ui(snapshot);
  app.state.flags.add('<kind>');
  app.state.errors.add('<script>');
  for (const html of [app.renderers.overview(), app.renderers.errors()]) {
    assert.doesNotMatch(html, /<img|<script>/);
    assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
  }
});

test('top-level files are grouped, bounded and discoverable through search', () => {
  const snapshot = largeRun();
  snapshot.files.forEach((file, index) => { file.path = `file-${index}.js`; });
  const app = ui(snapshot);
  const initial = app.renderers.environments();
  assert.match(initial, /data-root-files aria-expanded="false"/);
  assert.doesNotMatch(initial, /file-1554\.js/);
  app.state.rootFiles = true;
  const expanded = app.renderers.environments();
  assert.equal((expanded.match(/data-key="tree-/g) || []).length, 100);
  assert.match(expanded, /data-more-files/);
  app.state.fileSearch = 'file-1554.js';
  assert.match(app.renderers.environments(), /file-1554\.js/);
});

test('tree aggregation preserves snapshots and highlights current files with their ancestors', () => {
  const snapshot = structuredClone(run);
  snapshot.files = [
    { path: 'src', agents: { [snapshot.agents[0].id]: { reads: 1, writes: 0 } } },
    { path: 'src/api/events.ts', agents: { [snapshot.agents[0].id]: { reads: 2, writes: 1 } } }
  ];
  const original = JSON.stringify(snapshot);
  const app = ui(snapshot, true);
  assert.equal(app.buildFileTree().reads, 3);
  assert.equal(app.buildFileTree().reads, 3);
  assert.equal(JSON.stringify(snapshot), original);
  assert.deepEqual(Array.from(app.currentPaths()).sort(), ['src', 'src/api', 'src/api/events.ts']);
});

test('timeline zooms around the pointer, pans within the run and resumes following the live edge', () => {
  const app = ui(run, true);
  const start = Date.parse(run.window.start);
  const end = Date.parse(run.window.end);
  const full = end - start;
  assert.deepEqual(Array.from(app.bounds()), [start, end]);
  app.zoomTimeline(.25, .5);
  let [from, to] = app.bounds();
  assert.equal(to - from, full / 2);
  assert.equal(from, start + full * .125);
  app.panTimeline(-10);
  assert.equal(app.bounds()[0], start);
  app.panTimeline(10);
  assert.deepEqual(Array.from(app.bounds()), [end - full / 2, end]);
  assert.equal(app.state.center, null);
  app.zoomTimeline(.5, 1e-9);
  [from, to] = app.bounds();
  assert.equal(to - from, 2000);
  assert.match(app.renderers.timeline(), /data-zoom="in" disabled/);
  assert.doesNotMatch(app.renderers.timeline(), /data-zoom="out" disabled/);
  assert.match(app.renderers.timeline(), /\d\d:\d\d:\d\d<\/span>/);
  app.zoomTimeline(.5, 1e9);
  assert.equal(app.state.zoom, 100);
  assert.equal(app.state.center, null);
  assert.match(app.renderers.timeline(), /data-zoom="out" disabled/);
});

test('cached views have unique form IDs and labels address their own controls', () => {
  const app = ui();
  const ids = new Set();
  for (const view of ['agents', 'timeline', 'context', 'environments']) {
    app.state.view = view;
    const html = app.renderers[view]();
    const viewIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    for (const id of viewIds) {
      assert.equal(ids.has(id), false, `Duplicate ID: ${id}`);
      ids.add(id);
    }
    for (const [, target] of html.matchAll(/\bfor="([^"]+)"/g)) assert.ok(viewIds.includes(target));
  }
});
