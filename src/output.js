import { encode } from '@toon-format/toon';

export function print(data) {
  process.stdout.write(`${encode(data)}\n`);
}

export function printText(text) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function printError(err) {
  const body = { error: err.message, code: err.code };
  if (err.details) body.details = err.details;
  if (err.help?.length) body.help = err.help;
  process.stderr.write(`${encode(body)}\n`);
}
