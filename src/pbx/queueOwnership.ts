import { createHash } from 'node:crypto';

// The installed Asterisk extensions.exten column is varchar(40). Hashing the
// queue name keeps this non-dialable ownership marker within that native shape.
export const queueMarkerExten = (name: string) => `__aida_queue_${createHash('sha256').update(name).digest('hex').slice(0,27)}`;
export const queueMarkerData = (name: string) => `OfficePulse:queue:v1:${name}`;
export function recognizedQueueMarker(exten: string, appdata: string): string | undefined {
  const name = appdata.slice('OfficePulse:queue:v1:'.length);
  return /^[a-zA-Z0-9_.-]{1,80}$/.test(name) && appdata === queueMarkerData(name) && exten === queueMarkerExten(name) ? name : undefined;
}
