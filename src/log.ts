import type { JsonObject } from './types';

const isProd = process.env.NODE_ENV === 'production';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function createLogger(source: string) {
  const log = (level: LogLevel, message: string, data?: JsonObject) => {
    const entry = {
      level,
      message,
      source,
      timestamp: new Date().toISOString(),
      ...data,
    };

    const consoleMethod = level === 'debug' ? 'log' : level;

    if (isProd) {
      console[consoleMethod](JSON.stringify(entry));
    } else {
      const dataStr = data ? ` ${JSON.stringify(data)}` : '';
      console[consoleMethod](`${entry.timestamp} ${level} [${source}] ${message}${dataStr}`);
    }
  };

  return {
    debug: (message: string, data?: JsonObject) => log('debug', message, data),
    error: (message: string, data?: JsonObject) => log('error', message, data),
    info: (message: string, data?: JsonObject) => log('info', message, data),
    warn: (message: string, data?: JsonObject) => log('warn', message, data),
  };
}
