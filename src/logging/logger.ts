import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogSink = (line: string) => void;

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  fields?: Record<string, unknown>;
}

/**
 * Minimal structured JSON-lines logger with mandatory redaction.
 * All bound and per-call fields pass through redact() so credential
 * material can never reach stdout even by accident.
 */
export class Logger {
  private readonly level: LogLevel;
  private readonly sink: LogSink;
  private readonly fields: Record<string, unknown>;

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? 'info';
    this.sink = opts.sink ?? ((line) => process.stdout.write(line + '\n'));
    this.fields = opts.fields ?? {};
  }

  child(fields: Record<string, unknown>): Logger {
    return new Logger({ level: this.level, sink: this.sink, fields: { ...this.fields, ...fields } });
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.write('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.write('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.write('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.write('error', msg, fields);
  }

  private write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(redact({ ...this.fields, ...fields }) as Record<string, unknown>),
    };
    this.sink(JSON.stringify(record));
  }
}

export function nullLogger(): Logger {
  return new Logger({ level: 'error', sink: () => {} });
}
