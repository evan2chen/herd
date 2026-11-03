import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateReport } from '../../src/agent-files.js';

const valid = {
  id: 'h1-task',
  status: 'done',
  summary: 'Did the thing.',
  files_changed: ['a.txt'],
  verification: { command: 'cat a.txt', result: 'pass', detail: 'contents match' },
  questions: [],
  notes: '',
};

test('accepts a complete report', () => {
  assert.deepEqual(validateReport(valid, 'h1-task'), []);
});

test('accepts a report without optional questions and notes', () => {
  const { questions, notes, ...minimal } = valid;
  assert.deepEqual(validateReport(minimal, 'h1-task'), []);
});

test('rejects a report for another agent', () => {
  assert.deepEqual(validateReport(valid, 'h2-other'), ['id must be "h2-other"']);
});

test('rejects unknown status and verification values', () => {
  const errors = validateReport({ ...valid, status: 'complete', verification: { result: 'ok' } }, 'h1-task');
  assert.equal(errors.length, 2);
  assert.match(errors[0], /^status must be one of/);
  assert.match(errors[1], /^verification.result must be one of/);
});

test('requires questions when status is needs_input', () => {
  assert.deepEqual(validateReport({ ...valid, status: 'needs_input' }, 'h1-task'), ['needs_input requires at least one question']);
});

test('rejects wrong field types', () => {
  const errors = validateReport({ ...valid, summary: ' ', files_changed: 'a.txt', notes: 3 }, 'h1-task');
  assert.deepEqual(errors, ['summary must be a non-empty string', 'files_changed must be an array of strings', 'notes must be a string']);
});

test('rejects a non-object report', () => {
  assert.deepEqual(validateReport(['done'], 'h1-task'), ['report must be a JSON object']);
});
