import path from 'node:path';

export const CATEGORIES = ['render', 'test', 'build', 'install', 'script', 'git', 'edit', 'read', 'cleanup', 'other'];

export function normalizePath(value) {
  return String(value ?? '')
    .replace(/\\+/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
}

export function filePath(value, root, cwd = root) {
  let file = normalizePath(value).replace(/^['"]|['"]$/g, '');
  if (/^(?:\/dev\/null|nul|\$null|&\d+|&-)$/i.test(file)) return null;
  const base = normalizePath(root);
  const windows = /^[a-z]:/i.test(base);
  const compare = (v) => (windows ? v.toLowerCase() : v);
  const working = normalizePath(cwd);
  if (
    !file.startsWith('/') &&
    !/^[a-z]:/i.test(file) &&
    working &&
    base &&
    compare(working).startsWith(`${compare(base)}/`)
  )
    file = `${working.slice(base.length + 1)}/${file}`;
  if (base && compare(file).startsWith(`${compare(base)}/`)) file = file.slice(base.length + 1);
  else if (file.startsWith('/') || /^[a-z]:/i.test(file)) return null;
  file = path.posix.normalize(file).replace(/^\.\//, '');
  return file && file !== '.' && !file.startsWith('../') && !/[\n\r<>]/.test(file) ? file : null;
}

function commandPieces(command, { worktree } = {}) {
  const parts = [];
  let piped = false;
  let start = 0;
  let quote = null;
  let depth = 0;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (c === '`' && quote !== "'") {
      i += 1;
      continue;
    }
    if (c === '\\' && quote === '"' && /["\\$`]/.test(command[i + 1] ?? '')) {
      i += 1;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if ('({['.includes(c)) depth += 1;
    if (')}]'.includes(c)) depth = Math.max(0, depth - 1);
    if (!depth && (c === ';' || c === '|' || (c === '&' && command[i + 1] === '&'))) {
      if (c === '&' && command[i - 1] === '>') continue;
      if (c === '|' && command[i - 1] === '>') continue;
      parts.push({ text: command.slice(start, i).trim(), piped });
      piped = c === '|' && command[i + 1] !== '|';
      if (command[i + 1] === c) i += 1;
      start = i + 1;
    }
  }
  parts.push({ text: command.slice(start).trim(), piped });
  const first = parts[0]?.text.match(/^(?:cd|Set-Location)\s+(?:\/d\s+|-LiteralPath\s+|-Path\s+)?(.+)$/i);
  if (
    first &&
    worktree &&
    normalizePath(first[1].replace(/^['"]|['"]$/g, '')).toLowerCase() === normalizePath(worktree).toLowerCase()
  )
    parts.shift();
  return parts.filter((part) => part.text);
}

export function splitCommands(command, options = {}) {
  return commandPieces(command, options).map((part) => part.text);
}

const TABLE = [
  ['render', /\b(remotion\s+(?:render|still)|ffmpeg|blender|render)\b/i],
  ['test', /\b(test|pytest|vitest|jest|mocha|playwright|lint|typecheck|tsc\s+--noEmit)\b/i],
  ['build', /\b(build|webpack|vite\s+build|tsc|esbuild|cargo\s+build)\b/i],
  ['install', /\b(?:npm|pnpm|yarn|pip|uv|bun)\s+(?:ci|install|add|sync)\b/i],
  ['git', /^(?:git|gh|gh-axi)\b/i],
  ['cleanup', /^(?:rm|rmdir|del|Remove-Item|unlink)\b/i],
  ['edit', /^(?:sed\s+.*-i|touch|mkdir|cp|mv|Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item)\b/i],
  [
    'read',
    /^(?:cat|type|head|tail|rg|grep|find|ls|dir|wc|pwd|Get-Content|Get-ChildItem|Get-Location|Select-String|Test-Path)\b/i,
  ],
  ['script', /^(?:python[\d.]*|node|pwsh|powershell|bash|sh|tsx|ts-node)\b/i],
];

export function classifyCommand(command, { verify = [], commands = {} } = {}) {
  for (const [pattern, category] of Object.entries(commands)) {
    try {
      if (CATEGORIES.includes(category) && new RegExp(pattern, 'i').test(command)) return category;
    } catch {}
  }
  if (verify.some((v) => command.trim() === v.trim())) return 'test';
  return TABLE.find(([, pattern]) => pattern.test(command))?.[0] ?? 'other';
}

export function extractPaths(command, { worktree, cwd, category = classifyCommand(command) } = {}) {
  const read = [];
  const written = [];
  const tokens = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? [];
  let redirect = false;
  for (let i = 1; i < tokens.length; i += 1) {
    let token = tokens[i];
    if (/^(?:\d*>>?&(?:\d+|-)|&(?:\d+|-))$/.test(token)) {
      redirect = false;
      continue;
    }
    if (/^(?:\d?>>?|--output|-o|-OutFile|-FilePath|-LiteralPath|-Path)$/i.test(token)) {
      redirect = /^(?:\d?>>?|--output|-o|-OutFile)$/i.test(token);
      continue;
    }
    if (token.startsWith('-') || /^[\d]+$/.test(token)) continue;
    const match = token.match(/^(?:\d?>>?)(.+)$/);
    if (match) {
      redirect = true;
      token = match[1];
    }
    token = token.replace(/^['"]|['"]$/g, '');
    if (!redirect && !/[./\\]/.test(token)) continue;
    if (/^(?:\/dev\/null|nul|\$null)$/i.test(token)) {
      redirect = false;
      continue;
    }
    if (/[=*?{}();<>$`]/.test(token) || token.includes('://')) {
      redirect = false;
      continue;
    }
    const file = filePath(token, worktree, cwd);
    if (file) (redirect || category === 'edit' || category === 'cleanup' ? written : read).push(file);
    redirect = false;
  }
  for (const match of command.matchAll(
    /\b(readFileSync|readFile|writeFileSync|writeFile|open)\s*\(\s*['"]([^'"\r\n]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/g,
  )) {
    const file = filePath(match[2], worktree, cwd);
    if (file)
      (/^write/.test(match[1]) || (match[1] === 'open' && /[wax+]/.test(match[3] ?? '')) ? written : read).push(file);
  }
  for (const match of command.matchAll(/\bPath\s*\(\s*['"]([^'"\r\n]+)['"]\s*\)\.(read|write)_(?:text|bytes)\s*\(/g)) {
    const file = filePath(match[1], worktree, cwd);
    if (file) (match[2] === 'write' ? written : read).push(file);
  }
  return { read: [...new Set(read)], written: [...new Set(written)] };
}

export function analyzeShell(command, options = {}) {
  const pieces = commandPieces(command, options);
  if (!pieces.length) return [{ command: command.slice(0, 300), category: 'other', read: [], written: [] }];
  return pieces.map(({ text, piped }) => {
    const category = classifyCommand(text, options);
    const plumbing = piped && /^(?:head|tail|grep|wc|Select-Object|Select-String|Measure-Object)\b/i.test(text);
    return {
      command: text.slice(0, 300),
      category,
      ...extractPaths(text, { ...options, category }),
      ...(plumbing ? { plumbing: true } : {}),
    };
  });
}

function plumbing(piece) {
  return (
    piece.plumbing || /^(?:(?:export\s+)?[\w$]+\s*=|echo\b|printf\b|cd\b|Set-Location\b)/i.test(piece.command ?? '')
  );
}

export function primaryCategory(pieces) {
  const useful = pieces.filter((piece) => !plumbing(piece));
  return CATEGORIES.find((category) => useful.some((piece) => piece.category === category)) ?? 'other';
}

function errorLines(output) {
  return String(output ?? '')
    .replace(/\x1b\[[\d;]*m/g, '')
    .replace(/<\/?tool_use_error>/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\[[\w.# -]+ @ [\da-f]+\]\s*/i, ''));
}

function codeLine(line) {
  return (
    /^(?:[\w.]+\s*=|(?:const|let|var|return|throw|raise|if|def|class|import|from|export|function)\b|["'`{}#])/i.test(
      line,
    ) || /^[\w.]+\s*\((?![^)]*\):\s*(?:error|warning)\b)/i.test(line)
  );
}

function specificError(line) {
  if (codeLine(line)) return false;
  return (
    /^(?:[\w.]*(?:Error|Exception|Interrupt|Exit):|Error(?:\s|:)|fatal:|npm (?:ERR!|error\b))/i.test(line) ||
    /^(?:.*?:\s*)?(?:command not found|No such file or directory)\b/i.test(line) ||
    /\berror TS\d+\s*:/i.test(line) ||
    /^(?:[\w./\\:'" -]+:\s*)?(?:command not found|No such file or directory|permission denied)\b/i.test(line) ||
    /^(?:[\w./\\:'" -]+:\s*)[^\n]*(?:is not recognized|cannot find|ENOENT|EACCES)\b/i.test(line) ||
    /^spawn E(?:PERM|ACCES|NOENT)\b/.test(line)
  );
}

export function hasErrorOutput(output) {
  return errorLines(output).some((line) => specificError(line) || /^Traceback \(most recent call last\):$/.test(line));
}

function genericError(line) {
  return /^(?:(?:Error:\s*)?Command failed\b|(?:Process exited with code|Exit code)\s*:?\s*-?\d+\b)/i.test(line);
}

export function errorSignature(output) {
  const lines = errorLines(output);
  const traceback = lines.findIndex((line) => line.includes('Traceback (most recent call last)'));
  const exception =
    traceback < 0
      ? null
      : lines.slice(traceback + 1).findLast((line) => /^[\w.]+(?:Error|Exception|Interrupt|Exit):/.test(line));
  const specific = lines.find((line) => specificError(line) && !genericError(line));
  const fallback = lines.find(
    (line) =>
      !codeLine(line) &&
      !genericError(line) &&
      /\b(?:failed|failure|denied|not found|does not exist|unexpected EOF|invalid switch|segmentation fault)\b/i.test(
        line,
      ),
  );
  const line = exception ?? specific ?? fallback ?? 'Command failed';
  return line
    .trim()
    .replace(/(['"])(?:[a-z]:[\\/]|\/)[^'"\r\n]*\1/gi, '<path>')
    .replace(/(?:[a-z]:[\\/]|\/(?:[\w.@~-]+[\\/])+)[^\s'"<>:,;)]+/gi, '<path>')
    .replace(/(?:\.?\.?[\\/])?[\w@.-]+(?:[\\/][\w@.-]+)*\.[a-z][\w]*(?::\d+(?::\d+)?)?/gi, '<path>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b\d+(?:\.\d+)*\b/g, '<n>')
    .slice(0, 400);
}

export function errorFamily(signature) {
  return (
    signature.match(/\b[\w]*(?:Error|Exception)\b/)?.[0] ??
    (/denied|EACCES|permission/i.test(signature)
      ? 'permission'
      : /not found|cannot find|ENOENT|not recognized/i.test(signature)
        ? 'missing'
        : 'command')
  );
}
