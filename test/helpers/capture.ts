import { Logger, type LogLevel } from '../../src/logging/logger.js';

/** Logger writing to an in-memory buffer so tests can assert on output. */
export function captureLogger(level: LogLevel = 'debug'): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { logger: new Logger({ level, sink: (line) => lines.push(line) }), lines };
}
