import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createHarness, git, inHerdr } from './harness.js';

let h;

before(() => {
  if (!inHerdr) return;
  h = createHarness('herd-e2e-recap', { repoFiles: { 'README.md': '# demo\n' } });
});

after(() => {
  if (inHerdr) h.cleanup();
});

test('recap saves a self-contained file inside the project without dirtying it', { skip: !inHerdr }, () => {
  const result = h.herd('recap');
  assert.equal(result.status, 0, result.text);
  const recaps = path.join(fs.realpathSync(h.workDir), '.herd', 'recaps');
  assert.equal(path.dirname(result.out.file), recaps);
  assert.match(path.basename(result.out.file), /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.html$/);
  assert.match(fs.readFileSync(result.out.file, 'utf8'), /^<!doctype html>/i);
  assert.equal(git(h.workDir, 'status', '--porcelain', '--untracked-files=all'), '');
  const sessions = path.join(h.herdHome, 'sessions');
  const stored = fs.existsSync(sessions) ? fs.readdirSync(sessions).filter((session) => fs.existsSync(path.join(sessions, session, 'recaps'))) : [];
  assert.deepEqual(stored, []);
});

test('recap --out writes to the chosen path instead', { skip: !inHerdr }, () => {
  const custom = path.join(h.base, 'elsewhere', 'run.html');
  const result = h.herd('recap', '--out', custom);
  assert.equal(result.status, 0, result.text);
  assert.equal(result.out.file, custom);
  assert.ok(fs.existsSync(custom));
});
