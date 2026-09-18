import { createHash } from 'node:crypto';
import { DependencyUnavailableError } from '../errors.js';

// The installed Asterisk extensions.exten column is varchar(40). Hashing the
// queue name keeps this non-dialable ownership marker within that native shape.
export const queueMarkerExten = (name: string) => `__aida_queue_${createHash('sha256').update(name).digest('hex').slice(0,27)}`;
export const queueMarkerData = (name: string) => `OfficePulse:queue:v1:${name}`;
export function recognizedQueueMarker(exten: string, appdata: string): string | undefined {
  const name = appdata.slice('OfficePulse:queue:v1:'.length);
  return /^[a-zA-Z0-9_.-]{1,80}$/.test(name) && appdata === queueMarkerData(name) && exten === queueMarkerExten(name) ? name : undefined;
}

export type MarkerQuery = (sql: string, values: string[]) => Promise<Record<string, unknown>[]>;
/** The single context holding this queue's marker. Absent, or present in more than one context (ambiguous), means owned by nobody. */
export async function queueOwner(query: MarkerQuery, name: string, lock = false): Promise<string | undefined> {
  const rows = await query(`SELECT context FROM extensions WHERE BINARY exten=? AND priority=1 AND app='NoOp' AND BINARY appdata=? LIMIT 2${lock ? ' FOR UPDATE' : ''}`,
    [queueMarkerExten(name), queueMarkerData(name)]);
  return rows.length === 1 ? String(rows[0]!.context) : undefined;
}
/** Queue names whose only marker row lives in this context: exact versioned markers, never a native name prefix. */
export async function ownedQueueNames(query: MarkerQuery, context: string): Promise<string[]> {
  const oversized = () => new DependencyUnavailableError('PBX inventory exceeds the supported POC size');
  const markers = await query("SELECT exten, appdata FROM extensions WHERE BINARY context = ? AND priority = 1 AND app = 'NoOp' AND LEFT(exten, 13) = '__aida_queue_' ORDER BY exten LIMIT 1001", [context]);
  if (markers.length > 1000) throw oversized();
  const names = markers.map(row => recognizedQueueMarker(String(row.exten), String(row.appdata))).filter((name): name is string => name !== undefined);
  if (!names.length) return [];
  // The same marker in another context makes ownership ambiguous; that queue is then owned by nobody.
  const everywhere = await query(`SELECT context, exten, appdata FROM extensions WHERE BINARY exten IN (${names.map(() => '?').join(',')}) AND priority = 1 AND app = 'NoOp' LIMIT 1001`, names.map(queueMarkerExten));
  if (everywhere.length > 1000) throw oversized();
  const holders = new Map<string, number>();
  for (const row of everywhere) {
    const name = recognizedQueueMarker(String(row.exten), String(row.appdata));
    if (name) holders.set(name, (holders.get(name) ?? 0) + 1);
  }
  return names.filter(name => holders.get(name) === 1);
}
