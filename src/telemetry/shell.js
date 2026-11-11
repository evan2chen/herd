import path from 'node:path';

export const CATEGORIES = ['render', 'test', 'build', 'install', 'git', 'read', 'edit', 'script', 'cleanup', 'other'];

export function normalizePath(value) {
  return String(value ?? '').replace(/\\+/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

export function filePath(value, root, cwd = root) {
  let file = normalizePath(value).replace(/^['"]|['"]$/g, '');
  const base = normalizePath(root);
  const windows = /^[a-z]:/i.test(base);
  const compare = (v) => windows ? v.toLowerCase() : v;
  const working = normalizePath(cwd);
  if (!file.startsWith('/') && !/^[a-z]:/i.test(file) && working && base && compare(working).startsWith(`${compare(base)}/`)) file = `${working.slice(base.length + 1)}/${file}`;
  if (base && compare(file).startsWith(`${compare(base)}/`)) file = file.slice(base.length + 1);
  else if (file.startsWith('/') || /^[a-z]:/i.test(file)) return null;
  file = path.posix.normalize(file).replace(/^\.\//, '');
  return file && file !== '.' && !file.startsWith('../') && !/[\n\r<>]/.test(file) ? file : null;
}

export function splitCommands(command, { worktree } = {}) {
  const parts = [];
  let start = 0, quote = null, depth = 0;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (c === '`' && quote !== "'") { i += 1; continue; }
    if (c === '\\' && quote === '"' && /["\\$`]/.test(command[i + 1] ?? '')) { i += 1; continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ('({['.includes(c)) depth += 1;
    if (')}]'.includes(c)) depth = Math.max(0, depth - 1);
    if (!depth && (c === ';' || c === '|' || c === '&' && command[i + 1] === '&')) {
      if (c === '&' && command[i - 1] === '>') continue;
      if (c === '|' && command[i - 1] === '>' ) continue;
      parts.push(command.slice(start, i).trim());
      if (command[i + 1] === c) i += 1;
      start = i + 1;
    }
  }
  parts.push(command.slice(start).trim());
  const first = parts[0]?.match(/^(?:cd|Set-Location)\s+(?:\/d\s+|-LiteralPath\s+|-Path\s+)?(.+)$/i);
  if (first && worktree && normalizePath(first[1].replace(/^['"]|['"]$/g, '')).toLowerCase() === normalizePath(worktree).toLowerCase()) parts.shift();
  return parts.filter(Boolean);
}

const TABLE = [
  ['render', /\b(remotion\s+(?:render|still)|ffmpeg|blender|render)\b/i],
  ['test', /\b(test|pytest|vitest|jest|mocha|playwright|lint|typecheck|tsc\s+--noEmit)\b/i],
  ['build', /\b(build|webpack|vite\s+build|tsc|esbuild|cargo\s+build)\b/i],
  ['install', /\b(?:npm|pnpm|yarn|pip|uv|bun)\s+(?:ci|install|add|sync)\b/i],
  ['git', /^(?:git|gh|gh-axi)\b/i],
  ['cleanup', /^(?:rm|rmdir|del|Remove-Item|unlink)\b/i],
  ['edit', /^(?:sed\s+.*-i|touch|mkdir|cp|mv|Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item)\b/i],
  ['read', /^(?:cat|type|head|tail|rg|grep|find|ls|dir|wc|pwd|Get-Content|Get-ChildItem|Get-Location|Select-String|Test-Path)\b/i],
  ['script', /^(?:python[\d.]*|node|pwsh|powershell|bash|sh|tsx|ts-node)\b/i],
];

export function classifyCommand(command, { verify = [], commands = {} } = {}) {
  for (const [pattern, category] of Object.entries(commands)) {
    try { if (CATEGORIES.includes(category) && new RegExp(pattern, 'i').test(command)) return category; } catch {}
  }
  if (verify.some((v) => command.trim() === v.trim())) return 'test';
  return TABLE.find(([, pattern]) => pattern.test(command))?.[0] ?? 'other';
}

export function extractPaths(command, { worktree, cwd, category = classifyCommand(command) } = {}) {
  const read = [], written = [];
  const tokens = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? [];
  let redirect = false;
  for (let i = 1; i < tokens.length; i += 1) {
    let token = tokens[i];
    if (/^(?:\d?>>?|--output|-o|-OutFile|-FilePath|-LiteralPath|-Path)$/i.test(token)) { redirect = /^(?:\d?>>?|--output|-o|-OutFile)$/i.test(token); continue; }
    if (token.startsWith('-') || /^[\d]+$/.test(token)) continue;
    const match = token.match(/^(?:\d?>>?)(.+)$/);
    if (match) { redirect = true; token = match[1]; }
    token = token.replace(/^['"]|['"]$/g, '');
    if (!redirect && !/[./\\]/.test(token)) continue;
    if (/[=*?{}();<>$`]/.test(token) || token.includes('://')) continue;
    const file = filePath(token, worktree, cwd);
    if (file) (redirect || category === 'edit' || category === 'cleanup' ? written : read).push(file);
    redirect = false;
  }
  for (const match of command.matchAll(/\b(readFileSync|readFile|writeFileSync|writeFile|open)\s*\(\s*['"]([^'"\r\n]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/g)) {
    const file = filePath(match[2], worktree, cwd);
    if (file) (/^write/.test(match[1]) || match[1] === 'open' && /[wax+]/.test(match[3] ?? '') ? written : read).push(file);
  }
  for (const match of command.matchAll(/\bPath\s*\(\s*['"]([^'"\r\n]+)['"]\s*\)\.(read|write)_(?:text|bytes)\s*\(/g)) {
    const file = filePath(match[1], worktree, cwd); if (file) (match[2] === 'write' ? written : read).push(file);
  }
  return { read: [...new Set(read)], written: [...new Set(written)] };
}

export function analyzeShell(command, options = {}) {
  return splitCommands(command, options).map((text) => {
    const category = classifyCommand(text, options);
    return { command: text.slice(0, 300), category, ...extractPaths(text, { ...options, category }) };
  });
}

export function errorSignature(output) {
  const lines = String(output ?? '').replace(/\x1b\[[\d;]*m/g, '').split(/\r?\n/);
  const traceback = lines.findIndex((line) => line.includes('Traceback (most recent call last)'));
  const exception = traceback < 0 ? null : lines.slice(traceback + 1).findLast((line) => /^[\w.]+(?:Error|Exception|Interrupt|Exit):?/.test(line));
  const line = exception ?? lines.find((v) => /\b(error|exception|failed|failure|denied|not found|cannot find|not recognized|ENOENT|EACCES)\b/i.test(v)) ?? lines.find((v) => v.trim()) ?? 'Command failed';
  return line.trim().replace(/(['"])(?:[a-z]:[\\/]|\/)[^'"\r\n]*\1/gi, '<path>').replace(/(?:[a-z]:[\\/]|\/(?:[\w.@~-]+[\\/])+)[^\s'"<>:,;)]+/gi, '<path>')
    .replace(/(?:\.?\.?[\\/])?[\w@.-]+(?:[\\/][\w@.-]+)*\.[a-z][\w]*(?::\d+(?::\d+)?)?/gi, '<path>')
    .replace(/0x[0-9a-f]+/gi, '<hex>').replace(/\b\d+(?:\.\d+)*\b/g, '<n>').slice(0, 400);
}

export function errorFamily(signature) {
  return signature.match(/\b[\w]*(?:Error|Exception)\b/)?.[0] ?? (/denied|EACCES|permission/i.test(signature) ? 'permission' : /not found|cannot find|ENOENT|not recognized/i.test(signature) ? 'missing' : 'command');
}
