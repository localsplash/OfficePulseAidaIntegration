import type { Route } from './httpServer.js';

/** Private Admin contracts remain distinct from any future authenticated device routes. */
export function assembleApiRoutes(inventory: Route[], calls: Route[]): Route[] {
  return [...inventory, ...calls.map((route) => route.pattern.startsWith('/v1/calls/')
    ? { ...route, pattern: route.pattern.replace('/v1/calls/', '/v1/admin/calls/') } : route)];
}
