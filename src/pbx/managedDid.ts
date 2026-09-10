import { ValidationError } from '../errors.js';

export const SECONDS_PER_RING = 5;
export const NAME_RE = /^[a-zA-Z0-9_.-]{1,80}$/;
export const E164_RE = /^\+[1-9][0-9]{6,14}$/;
export const TIME_RANGE_RE = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]-(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAYS_RE = /^(?:sun|mon|tue|wed|thu|fri|sat)(?:-(?:sun|mon|tue|wed|thu|fri|sat))?(?:&(?:sun|mon|tue|wed|thu|fri|sat)(?:-(?:sun|mon|tue|wed|thu|fri|sat))?)*$/;
export interface DidSchedule { timeRange: string; weekdays: string; timezone: string }
export interface DidSettings { queue: string; ringsBeforeAi: number; livekitDestination?: string; schedule?: DidSchedule }
export interface DialplanRow { priority: number; app: string; appdata: string }

export function object(body: unknown, allowed?: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('request body must be a JSON object');
  const result = body as Record<string, unknown>;
  if (allowed && Object.keys(result).some(key => !allowed.includes(key))) throw new ValidationError('request contains unsupported fields');
  return result;
}
export function e164(value: unknown, field = 'DID'): string {
  if (typeof value !== 'string' || !E164_RE.test(value)) throw new ValidationError(`${field} must be E.164 including leading +`);
  return value;
}
export function name(value: unknown, field: string): string {
  if (typeof value !== 'string' || !NAME_RE.test(value)) throw new ValidationError(`${field} contains unsupported characters`);
  return value;
}
export function normalizeWeekdays(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !WEEKDAYS_RE.test(value)) throw new ValidationError('schedule.weekdays must use Asterisk days/ranges such as mon-fri');
  const selected = new Set<number>();
  for (const term of value.split('&')) {
    const [start, end = start] = term.split('-');
    const first = DAYS.indexOf(start!); const last = DAYS.indexOf(end!);
    for (let day = first; ; day = (day + 1) % 7) { selected.add(day); if (day === last) break; }
  }
  return DAYS.filter((_, index) => selected.has(index)).join('&');
}
export function parseSchedule(value: unknown): DidSchedule | undefined {
  if (value === undefined || value === null) return undefined;
  const schedule = object(value, ['timeRange', 'weekdays', 'timezone']);
  if (typeof schedule.timeRange !== 'string' || !TIME_RANGE_RE.test(schedule.timeRange)) throw new ValidationError('schedule.timeRange must be HH:MM-HH:MM');
  const timezone = schedule.timezone;
  if (typeof timezone !== 'string' || timezone.length > 64 || !(timezone === 'UTC' || /^[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)+$/.test(timezone))) throw new ValidationError('schedule.timezone must be an IANA timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0); } catch { throw new ValidationError('schedule.timezone must be an IANA timezone'); }
  return { timeRange: schedule.timeRange, weekdays: normalizeWeekdays(schedule.weekdays), timezone };
}
export function parseDidSettings(value: unknown): DidSettings {
  const body = object(value, ['queue', 'ringsBeforeAi', 'schedule', 'livekitDestination']);
  const queue = name(body.queue, 'queue'); const rings = body.ringsBeforeAi;
  if (!Number.isInteger(rings) || Number(rings) < 1 || Number(rings) > 12) throw new ValidationError('ringsBeforeAi must be an integer in [1, 12]');
  const schedule = parseSchedule(body.schedule);
  const livekitDestination = body.livekitDestination === undefined ? undefined : e164(body.livekitDestination, 'livekitDestination');
  return { queue, ringsBeforeAi: Number(rings), ...(schedule ? { schedule } : {}), ...(livekitDestination ? { livekitDestination } : {}) };
}

/** A version marker and fixed, validated argument grammar allow exact readback without parsing manual dialplan. */
export function didDialplanRows(did: string, input: DidSettings): DialplanRow[] {
  e164(did);
  const settings = parseDidSettings(input);
  const args = [settings.queue, settings.ringsBeforeAi, settings.livekitDestination ?? did,
    settings.schedule?.timeRange ?? '*', settings.schedule?.weekdays ?? '*', settings.schedule?.timezone ?? 'UTC'];
  const appdata = `aida-managed-did-v1,s,1(${args.join(',')})`;
  if (appdata.length > 255) throw new ValidationError('DID settings exceed the installed Realtime argument limit');
  return [
    { priority: 1, app: 'NoOp', appdata: `OfficePulse:did:v1:${did}` },
    { priority: 2, app: 'Gosub', appdata },
    { priority: 3, app: 'Hangup', appdata: '' },
  ];
}
export function recognizeDidRows(did: string, rows: readonly DialplanRow[]): DidSettings | undefined {
  if (rows.length !== 3) return undefined;
  const ordered = [...rows].sort((a, b) => a.priority - b.priority);
  const match = /^aida-managed-did-v1,s,1\(([^()]*)\)$/.exec(ordered[1]?.appdata ?? '');
  if (!match) return undefined;
  const args = match[1]!.split(',');
  if (args.length !== 6) return undefined;
  const [queue, rings, livekitDestination, timeRange, weekdays, timezone] = args;
  try {
    const settings = parseDidSettings({ queue, ringsBeforeAi: Number(rings), livekitDestination,
      ...(timeRange === '*' && weekdays === '*' && timezone === 'UTC' ? {} : { schedule: { timeRange, weekdays, timezone } }) });
    const expected = didDialplanRows(did, settings);
    if (!ordered.every((row, index) => row.priority === expected[index]!.priority && row.app === expected[index]!.app && row.appdata === expected[index]!.appdata)) return undefined;
    return settings;
  } catch { return undefined; }
}
export function managedDid(did: string, settings: DidSettings) {
  return { did, managed: true as const, ...settings, livekitDestination: settings.livekitDestination ?? did,
    ringTimeoutSeconds: settings.ringsBeforeAi * SECONDS_PER_RING, applyState: 'committed' as const };
}
