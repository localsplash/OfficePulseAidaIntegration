import type { Route } from './httpServer.js';
import { legacyPbxProvisioning } from '../pbx/inventory.js';

/** Apply the write policy after every route family has joined the server. */
export function assembleApiRoutes(devices: Route[], inventory: Route[], calls: Route[], legacyEnabled: boolean): Route[] {
  return legacyPbxProvisioning([
    ...devices,
    ...inventory,
    ...calls.map((route) => route.pattern.startsWith('/v1/calls/')
      ? { ...route, pattern: route.pattern.replace('/v1/calls/', '/v1/admin/calls/') } : route),
  ], legacyEnabled);
}
