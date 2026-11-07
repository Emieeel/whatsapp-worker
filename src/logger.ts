import pino, { type Logger } from 'pino';
import pretty from 'pino-pretty';

/**
 * Human-readable logs on stdout (also inside Docker). pino-pretty runs in-process as a
 * stream, not as a worker-thread transport, to keep memory use low.
 */
export function createLogger(level: string): Logger {
  const stream = pretty({
    colorize: process.stdout.isTTY,
    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
    ignore: 'pid,hostname',
    sync: true,
  });
  return pino({ level }, stream);
}
