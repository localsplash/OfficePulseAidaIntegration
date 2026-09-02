import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { AriClient } from '../src/ari/ariClient.js';
import { captureLogger } from './helpers/capture.js';

interface FakeAriServer {
  port: number;
  connections: number;
  urls: string[];
  broadcast: (event: unknown) => void;
  dropAll: () => void;
  close: () => Promise<void>;
}

function startFakeAriWs(): Promise<FakeAriServer> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    const state: FakeAriServer = {
      port: 0,
      connections: 0,
      urls: [],
      broadcast: (event) => {
        for (const client of wss.clients) client.send(JSON.stringify(event));
      },
      dropAll: () => {
        for (const client of wss.clients) client.terminate();
      },
      close: () =>
        new Promise<void>((res) => {
          for (const client of wss.clients) client.terminate();
          wss.close(() => res());
        }),
    };
    wss.on('connection', (_socket, req) => {
      state.connections += 1;
      state.urls.push(req.url ?? '');
    });
    wss.on('listening', () => {
      state.port = (wss.address() as { port: number }).port;
      resolve(state);
    });
  });
}

test('connects, receives typed events, and reconnects after a drop', async () => {
  const server = await startFakeAriWs();
  const { logger } = captureLogger();
  const connectionStates: boolean[] = [];
  const client = new AriClient({
    url: `http://127.0.0.1:${server.port}/ari`,
    username: 'aida',
    password: 'pw',
    app: 'aida',
    logger,
    reconnectMinMs: 30,
    reconnectMaxMs: 100,
    onConnectionState: (connected) => connectionStates.push(connected),
  });

  const firstConnect = new Promise<void>((r) => client.once('connected', () => r()));
  client.start();
  await firstConnect;

  const gotEvent = new Promise<Record<string, unknown>>((r) => client.once('StasisStart', (ev) => r(ev as Record<string, unknown>)));
  server.broadcast({ type: 'StasisStart', args: ['screen', 'cs-1'], channel: { id: 'c1', name: 'X', state: 'Up' } });
  const event = await gotEvent;
  assert.deepEqual(event.args, ['screen', 'cs-1']);

  // Drop the socket; the client must reconnect on its own.
  const reconnect = new Promise<void>((r) => client.once('connected', () => r()));
  server.dropAll();
  await reconnect;
  assert.equal(server.connections, 2);
  assert.deepEqual(connectionStates, [true, false, true]);

  // Credentials go in the query string of the events URL, app scoped.
  assert.ok(server.urls[0]?.includes('app=aida'));
  assert.ok(server.urls[0]?.includes('subscribeAll=true'));

  client.stop();
  await server.close();
});

test('REST requests carry basic auth and surface HTTP errors', async () => {
  const { logger } = captureLogger();
  const seen: Array<{ url: string; auth?: string; method?: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url: String(input), auth: headers.authorization, method: init?.method });
    if (String(input).includes('/channels/broken')) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ id: 'c9', name: 'PJSIP/x', state: 'Down' }), { status: 200 });
  }) as typeof fetch;
  const client = new AriClient({
    url: 'http://127.0.0.1:9/ari',
    username: 'aida',
    password: 'pw',
    app: 'aida',
    logger,
    fetchImpl,
  });

  const channel = await client.originate({ endpoint: 'Local/100@office', appArgs: 'human,cs-1,k1', timeoutSeconds: 20 });
  assert.equal(channel.id, 'c9');
  const first = seen[0];
  assert.equal(first?.method, 'POST');
  assert.equal(first?.auth, `Basic ${Buffer.from('aida:pw').toString('base64')}`);
  const url = new URL(first?.url as string);
  assert.equal(url.searchParams.get('endpoint'), 'Local/100@office');
  assert.equal(url.searchParams.get('timeout'), '20');
  assert.equal(url.searchParams.get('app'), 'aida');

  await assert.rejects(client.hangup('broken'), /returned 404/);
});
