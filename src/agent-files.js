import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';
import { sessionDir } from './paths.js';

export const REPORT_STATUSES = ['done', 'needs_input', 'failed'];
const VERIFICATION_RESULTS = ['pass', 'fail', 'not_run'];
const SETTLE_MS = 3000;

export function agentFiles(cwd, id) {
  const dir = path.join(cwd, '.herd', id);
  return { dir, brief: path.join(dir, 'brief.md'), report: path.join(dir, 'report.json') };
}

export function excludeFromGit(cwd) {
  const { status, stdout } = run('git', ['-C', cwd, 'rev-parse', '--git-common-dir']);
  if (status !== 0) return;
  const infoDir = path.join(path.resolve(cwd, stdout.trim()), 'info');
  const exclude = path.join(infoDir, 'exclude');
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (current.split(/\r?\n/).includes('.herd/')) return;
  fs.mkdirSync(infoDir, { recursive: true });
  fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}.herd/\n`);
}

function contractLines({ cwd, mode, scope, worktree, branch, base, verify }) {
  const location = worktree
    ? `Your working directory is ${cwd}, inside an isolated git worktree ${branch ? `on branch ${branch}` : 'on a detached HEAD'} based on commit ${base.slice(0, 12)}.`
    : `Your working directory is ${cwd}.`;
  const edits = mode === 'read'
    ? 'This is a read-only task: leave every file unchanged apart from your report.'
    : scope.length
      ? `Edit only files matching ${scope.join(', ')} (paths relative to the repository root).`
      : 'Edit only the files the task requires.';
  return [
    location,
    edits,
    ...(worktree ? ['Leave version control to herd: it commits your changes after you report, so keep git history, branches and remotes as they are.'] : []),
    'Create and edit files with your file-editing tools, and use the shell only to inspect files and run verification, one simple command at a time.',
    'Complete the task yourself in this session.',
    verify.length
      ? `Verify your work with ${verify.map((command) => `\`${command}\``).join(' and ')}, and record the result in the report.`
      : 'Verify your work before reporting, and record how in the report.',
  ];
}

function renderBrief(entry, task) {
  const { id, report } = entry;
  return `# Task ${id}

${task.trim()}

## Operating contract

${contractLines(entry).map((line) => `- ${line}`).join('\n')}
- When the task needs a decision you cannot make, report status "needs_input" with your questions, then stop.
- Finish by writing your report to ${report} as JSON in the format below, then stop and wait.
- When you receive a follow-up message, finish it the same way by writing a fresh report to the same path.

## Report format

\`\`\`json
{
  "id": "${id}",
  "status": "done | needs_input | failed",
  "summary": "What you did and the outcome, in one to three sentences",
  "files_changed": ["relative/path/of/each/file/you/changed"],
  "verification": { "command": "how you verified, or empty", "result": "pass | fail | not_run", "detail": "short evidence" },
  "questions": ["each question, only for needs_input"],
  "notes": "anything the orchestrator should know, or empty"
}
\`\`\`
`;
}

export function writeBrief(entry, anchorPane) {
  const files = agentFiles(entry.cwd, entry.id);
  fs.mkdirSync(files.dir, { recursive: true });
  excludeFromGit(entry.cwd);
  const brief = renderBrief({ ...entry, report: files.report }, fs.readFileSync(entry.task, 'utf8'));
  fs.writeFileSync(files.brief, brief);
  const archive = path.join(sessionDir(anchorPane), 'briefs');
  fs.mkdirSync(archive, { recursive: true });
  fs.writeFileSync(path.join(archive, `${entry.id}.md`), brief);
  return files;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

export function validateReport(report, id) {
  if (!isObject(report)) return ['report must be a JSON object'];
  const errors = [];
  if (report.id !== id) errors.push(`id must be "${id}"`);
  if (!REPORT_STATUSES.includes(report.status)) errors.push(`status must be one of ${REPORT_STATUSES.join(', ')}`);
  if (typeof report.summary !== 'string' || !report.summary.trim()) errors.push('summary must be a non-empty string');
  if (!isStringArray(report.files_changed)) errors.push('files_changed must be an array of strings');
  if (!isObject(report.verification) || !VERIFICATION_RESULTS.includes(report.verification.result)) {
    errors.push(`verification.result must be one of ${VERIFICATION_RESULTS.join(', ')}`);
  }
  if (report.questions !== undefined && !isStringArray(report.questions)) errors.push('questions must be an array of strings');
  if (report.status === 'needs_input' && !report.questions?.length) errors.push('needs_input requires at least one question');
  if (report.notes !== undefined && typeof report.notes !== 'string') errors.push('notes must be a string');
  return errors;
}

export function readReport(entry) {
  let stat;
  try {
    stat = fs.statSync(entry.report);
  } catch {
    return { state: 'missing' };
  }
  if (Date.now() - stat.mtimeMs < SETTLE_MS) return { state: 'settling' };
  let report;
  try {
    report = JSON.parse(fs.readFileSync(entry.report, 'utf8'));
  } catch (err) {
    return { state: 'invalid', errors: [`not valid JSON: ${err.message}`], mtimeMs: stat.mtimeMs };
  }
  const errors = validateReport(report, entry.id);
  return errors.length ? { state: 'invalid', errors, mtimeMs: stat.mtimeMs } : { state: 'valid', report, mtimeMs: stat.mtimeMs };
}

export function archiveReport(entry, anchorPane, name) {
  const archive = path.join(sessionDir(anchorPane), 'reports');
  fs.mkdirSync(archive, { recursive: true });
  const target = path.join(archive, name);
  fs.copyFileSync(entry.report, target);
  return target;
}
