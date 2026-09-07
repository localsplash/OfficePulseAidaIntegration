import type { Route } from './httpServer.js';

/** Apply to PBX/call routes before adding independent device enrollment routes. */
export function voiceAvailability(routes: Route[], enabled: boolean): Route[] {
  if (enabled) return routes;
  return routes.map((route) => route.method === 'GET' ? route : {
    ...route,
    handler: () => ({ status: 503, body: {
      error: 'voice_unavailable',
      message: 'Voice connectors disabled; configure PBX and LiveKit',
    } }),
  });
}
