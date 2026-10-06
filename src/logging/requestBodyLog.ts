import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact } from './redact.js';

export interface RequestBodyEntry {
  correlationId: string;
  method: string;
  path: string;
  clientIp: string;
  userAgent?: string;
  contentType?: string;
  raw: Buffer;
  status: number;
  error?: string;
}

const PREFIX = 'handset-requests-';
const DAY_MS = 86_400_000;
const MAX_RAW_CHARS = 8192;

/** systemd LogsDirectory= when running as the service; a temp directory in development and tests. */
export const defaultRequestLogDir = (): string =>
  process.env.LOGS_DIRECTORY?.split(':')[0] || join(tmpdir(), 'officepulse-aida-integration');

/**
 * Always-on JSON-lines record of handset request bodies, one file per UTC day,
 * deleted once older than `retentionDays`. Valid JSON is stored parsed (so null,
 * "" and a missing field stay distinguishable) with secret-looking keys redacted;
 * anything else is stored as text. Response bodies are never recorded because an
 * attach response carries the device token. A write failure never affects a request.
 */
export class RequestBodyLog {
  private queue: Promise<void> = Promise.resolve();
  private day = '';
  private failing = false;

  constructor(
    readonly dir = defaultRequestLogDir(),
    private readonly retentionDays = 14,
    private readonly onError: (err: unknown) => void = () => {},
    private readonly now = Date.now,
  ) {}

  write(entry: RequestBodyEntry): Promise<void> {
    const at = new Date(this.now());
    const { raw, ...fields } = entry;
    const line = JSON.stringify({ ts: at.toISOString(), ...fields, bytes: raw.length, ...decodeBody(raw) }) + '\n';
    this.queue = this.queue.then(async () => {
      try {
        const day = at.toISOString().slice(0, 10);
        if (day !== this.day) {
          await mkdir(this.dir, { recursive: true, mode: 0o750 });
          await this.prune(day);
          this.day = day;
        }
        await appendFile(join(this.dir, `${PREFIX}${day}.jsonl`), line, { mode: 0o640 });
        this.failing = false;
      } catch (err) {
        if (!this.failing) this.onError(err);
        this.failing = true;
      }
    });
    return this.queue;
  }

  private async prune(today: string): Promise<void> {
    const cutoff = Date.parse(today) - this.retentionDays * DAY_MS;
    for (const name of await readdir(this.dir)) {
      const day = new RegExp(`^${PREFIX}(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`).exec(name)?.[1];
      if (day && Date.parse(day) < cutoff) await unlink(join(this.dir, name)).catch(() => {});
    }
  }
}

function decodeBody(raw: Buffer): { body?: unknown; rawBody?: string; truncated?: true } {
  if (!raw.length) return {};
  const text = raw.toString('utf8');
  try {
    return { body: redact(JSON.parse(text)) };
  } catch {
    return { rawBody: text.slice(0, MAX_RAW_CHARS), ...(text.length > MAX_RAW_CHARS ? { truncated: true as const } : {}) };
  }
}
