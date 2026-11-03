export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  noProvider: 3,
  timeout: 5,
};

export class HerdError extends Error {
  constructor(code, message, { exitCode = EXIT.error, help = [], details } = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.help = help;
    this.details = details;
  }
}
