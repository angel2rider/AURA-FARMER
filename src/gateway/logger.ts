type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: Level = 'info';

export function setLogLevel(level: Level): void {
  threshold = level;
}

function write(level: Level, message: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  if (extra === undefined) {
    console[level === 'debug' ? 'log' : level](line);
  } else {
    console[level === 'debug' ? 'log' : level](line, extra);
  }
}

export const log = {
  debug: (message: string, extra?: unknown) => write('debug', message, extra),
  info: (message: string, extra?: unknown) => write('info', message, extra),
  warn: (message: string, extra?: unknown) => write('warn', message, extra),
  error: (message: string, extra?: unknown) => write('error', message, extra),
};
