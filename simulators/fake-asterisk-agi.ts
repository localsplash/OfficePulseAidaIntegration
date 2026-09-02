import net from 'node:net';

/**
 * Simulator: plays the Asterisk side of a FastAGI /bootstrap call against
 * a running integration service, printing every AGI command it receives
 * and the channel variables the service sets.
 *
 * Usage: npm run simulate:agi [-- host port did callerid]
 */
const [host = '127.0.0.1', portArg = '4573', did = '15559870001', callerid = '15551230001'] = process.argv.slice(2);
const port = Number(portArg);
const uniqueid = `${Math.floor(Date.now() / 1000)}.${Math.floor(Math.random() * 1000)}`;

const env: Record<string, string> = {
  agi_network: 'yes',
  agi_network_script: 'bootstrap',
  agi_request: `agi://${host}:${port}/bootstrap`,
  agi_channel: 'PJSIP/simulated-00000001',
  agi_language: 'en',
  agi_uniqueid: uniqueid,
  agi_callerid: callerid,
  agi_extension: did,
  agi_context: 'aida-inbound',
};

const channelVars: Record<string, string> = {
  ASTERISK_LINKEDID: uniqueid,
  OFFICEPULSE_INSTANCE_ID: 'op-simulator',
};

const socket = net.connect(port, host, () => {
  console.log(`connected to agi://${host}:${port}/bootstrap (linkedid ${uniqueid})`);
  socket.write(
    Object.entries(env)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n') + '\n\n',
  );
});

let buffer = '';
socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx: number;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim() === '') continue;
    console.log(`<- ${line}`);
    const get = /^GET VARIABLE (\S+)/.exec(line);
    if (get) {
      const value = channelVars[get[1] ?? ''];
      socket.write(value !== undefined ? `200 result=1 (${value})\n` : '200 result=0\n');
      continue;
    }
    const set = /^SET VARIABLE (\S+) "((?:[^"\\]|\\.)*)"/.exec(line);
    if (set) {
      const name = set[1] ?? '';
      const value = (set[2] ?? '').replace(/\\(.)/g, '$1');
      console.log(`   channel var ${name} = ${/TOKEN/i.test(name) ? '[redacted for display]' : value}`);
      socket.write('200 result=1\n');
      continue;
    }
    socket.write('200 result=1\n');
  }
});

socket.on('close', () => {
  console.log('AGI session closed by service (dialplan would continue here)');
});
socket.on('error', (err) => {
  console.error(`connection failed: ${err.message}`);
  process.exit(1);
});
