import { createHash } from 'node:crypto';

// Native extensions.exten commonly permits only 80 characters. Hashing the
// queue name keeps this non-dialable ownership marker bounded even at 80 bytes.
export const queueMarkerExten = (name: string) => `__aida_queue_${createHash('sha256').update(name).digest('hex').slice(0,40)}`;
export const queueMarkerData = (name: string) => `OfficePulse:queue:v1:${name}`;
export function recognizedQueueMarker(exten: string, appdata: string): string | undefined {
  const name = appdata.slice('OfficePulse:queue:v1:'.length);
  return /^[a-zA-Z0-9_.-]{1,80}$/.test(name) && appdata === queueMarkerData(name) && exten === queueMarkerExten(name) ? name : undefined;
}
