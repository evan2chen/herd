const TAIL_LINES = 15;

export function detectRateLimit(screen, patterns = []) {
  const expressions = patterns.map((pattern) => new RegExp(pattern, 'i'));
  const tail = screen.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-TAIL_LINES);
  return tail.find((line) => expressions.some((expression) => expression.test(line))) ?? null;
}
