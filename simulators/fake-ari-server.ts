import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * Simulator: a minimal fake ARI server (REST + events WebSocket) so the
 * integration service can run locally with no Asterisk. Accepts any
 * credentials, records channels/bridges in memory, and lets you inject
 * events by typing JSON lines on stdin, e.g.:
 *
 *   {"type":"StasisStart","args":["screen","cs-1"],"channel":{"id":"c1","name":"PJSIP/x","state":"Up"}}
 *
 * Usage: npm run simulate:ari [-- port]   (default 8088; ARI_URL=http://127.0.0.1:8088/ari)
 */
const port = Number(process.argv[2] ?? 8088);

const channels = new Map<string, Record<string, unknown>>();
const bridges = new Map<string, { id: string; bridge_type: string; channels: string[] }>();
const sockets = new Set<WebSocket>();
let nextId = 1;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const respond = (status: number, body?: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const path = url.pathname;
  console.log(`REST ${req.method} ${path}${url.search}`);

  if (req.method === 'POST' && path === '/ari/channels') {
    const id = `sim-${nextId++}`;
    const channel = { id, name: `SIM/${id}`, state: 'Down' };
    channels.set(id, channel);
    respond(200, channel);
    return;
  }
  if (req.method === 'GET' && path === '/ari/channels') {
    respond(200, [...channels.values()]);
    return;
  }
  if (req.method === 'DELETE' && path.startsWith('/ari/channels/')) {
    const id = decodeURIComponent(path.split('/')[3] ?? '');
    channels.delete(id);
    broadcast({ type: 'ChannelDestroyed', cause: 16, channel: { id, name: `SIM/${id}`, state: 'Down' } });
    respond(204);
    return;
  }
  if (req.method === 'POST' && path === '/ari/bridges') {
    const id = `bridge-${nextId++}`;
    const bridge = { id, bridge_type: url.searchParams.get('type') ?? 'mixing', channels: [] };
    bridges.set(id, bridge);
    respond(200, bridge);
    return;
  }
  if (req.method === 'GET' && path === '/ari/bridges') {
    respond(200, [...bridges.values()]);
    return;
  }
  if (req.method === 'POST' && /^\/ari\/bridges\/[^/]+\/(addChannel|removeChannel|moh)$/.test(path)) {
    const bridgeId = path.split('/')[3] ?? '';
    const bridge = bridges.get(bridgeId);
    const channelId = url.searchParams.get('channel');
    if (bridge && channelId) {
      if (path.endsWith('addChannel')) bridge.channels.push(channelId);
      else if (path.endsWith('removeChannel')) bridge.channels = bridge.channels.filter((c) => c !== channelId);
    }
    respond(204);
    return;
  }
  if (path.startsWith('/ari/channels/') && path.endsWith('/variable')) {
    respond(req.method === 'GET' ? 200 : 204, req.method === 'GET' ? { value: '' } : undefined);
    return;
  }
  if (path.startsWith('/ari/')) {
    respond(204);
    return;
  }
  respond(404, { message: 'not found' });
});

const wss = new WebSocketServer({ server, path: '/ari/events' });
wss.on('connection', (socket, req) => {
  console.log(`WS connected: ${req.url}`);
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

function broadcast(event: unknown): void {
  const payload = JSON.stringify(event);
  for (const socket of sockets) socket.send(payload);
}

process.stdin.setEncoding('utf8');
let stdinBuffer = '';
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  let idx: number;
  while ((idx = stdinBuffer.indexOf('\n')) !== -1) {
    const line = stdinBuffer.slice(0, idx).trim();
    stdinBuffer = stdinBuffer.slice(idx + 1);
    if (line === '') continue;
    try {
      broadcast(JSON.parse(line));
      console.log('event broadcast');
    } catch {
      console.error('not valid JSON, ignored');
    }
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fake ARI on http://127.0.0.1:${port}/ari (events at ws://127.0.0.1:${port}/ari/events)`);
  console.log('type JSON events on stdin to broadcast to connected clients');
});
