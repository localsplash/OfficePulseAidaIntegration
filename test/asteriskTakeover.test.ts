import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const run = promisify(execFile);
const binary = process.env.TEST_ASTERISK_BINARY;

test('isolated Asterisk sends Call-Info only through guarded handset takeover and refuses malformed/busy targets', { skip: !binary, timeout: 40000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'aida-takeover-test-'));
  for (const folder of ['run','log','spool','data','cache']) await mkdir(join(root, folder));
  const phone = dgram.createSocket('udp4'); const invites: string[] = [];
  await new Promise<void>(resolve => phone.bind(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => phone.close(() => resolve())));
  phone.on('message', (packet, peer) => {
    const message = packet.toString(); if (!message.startsWith('INVITE ')) return;
    invites.push(message);
    const header = (key: string) => new RegExp(`^${key}: (.*)$`, 'im').exec(message)?.[1]?.trim() ?? '';
    const reply = ['SIP/2.0 486 Busy Here', `Via: ${header('Via')}`, `From: ${header('From')}`, `To: ${header('To')};tag=test`, `Call-ID: ${header('Call-ID')}`, `CSeq: ${header('CSeq')}`, 'Content-Length: 0', '', ''].join('\r\n');
    phone.send(reply, peer.port, peer.address);
  });
  // Reserve an independent loopback signaling port, never the installed PBX port.
  const probe = dgram.createSocket('udp4'); await new Promise<void>(resolve => probe.bind(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const cfg = join(root, 'asterisk.conf');
  await writeFile(cfg, `[directories]\nastetcdir => ${root}\nastmoddir => ${process.env.TEST_ASTERISK_MODULE_DIR ?? '/usr/lib/asterisk/modules'}\nastvarlibdir => ${root}/data\nastdbdir => ${root}/data\nastkeydir => ${root}/data\nastdatadir => ${process.env.TEST_ASTERISK_DATA_DIR ?? '/var/lib/asterisk'}\nastagidir => ${root}/data\nastspooldir => ${root}/spool\nastrundir => ${root}/run\nastlogdir => ${root}/log\nastcachedir => ${root}/cache\n[options]\nverbose=4\n`);
  const modules = ['res_timing_timerfd','res_clioriginate','bridge_simple','bridge_holding','bridge_builtin_features','func_strings','func_logic','func_devstate','app_stack','app_dial','app_verbose','app_waituntil','pbx_config','res_sorcery_config','res_sorcery_memory','res_sorcery_astdb','res_pjproject','res_pjsip','res_pjsip_session','res_pjsip_registrar','res_pjsip_pubsub','res_pjsip_endpoint_identifier_ip','res_pjsip_header_funcs','res_pjsip_caller_id','res_pjsip_sdp_rtp','res_rtp_asterisk','chan_pjsip','codec_ulaw'];
  await writeFile(join(root, 'modules.conf'), '[modules]\nautoload=no\n' + modules.map(m => `load=${m}.so`).join('\n') + '\n');
  await writeFile(join(root, 'logger.conf'), '[general]\n[logfiles]\nconsole=>notice,warning,error,verbose\n');
  await writeFile(join(root, 'manager.conf'), '[general]\nenabled=no\n'); await writeFile(join(root, 'http.conf'), '[general]\nenabled=no\n');
  await writeFile(join(root, 'rtp.conf'), '[general]\nrtpstart=28000\nrtpend=28100\n');
  await writeFile(join(root, 'pjsip.conf'), `[transport]\ntype=transport\nprotocol=udp\nbind=127.0.0.1:${port}\n[411]\ntype=endpoint\ntransport=transport\ncontext=normal\ndisallow=all\nallow=ulaw\naors=411\n[411]\ntype=aor\ncontact=sip:411@127.0.0.1:${phone.address().port}\nqualify_frequency=0\n`);
  const source = await readFile(new URL('../asterisk/extensions_aida.conf', import.meta.url), 'utf8');
  await writeFile(join(root, 'extensions.conf'), source + '\n[test]\nexten => guarded,1,Set(__AIDA_TAKEOVER=1)\n same => n,Set(__AIDA_TAKEOVER_RING_SECONDS=5)\n same => n,Goto(aida-takeover,411,1)\nexten => invalid,1,Set(__AIDA_TAKEOVER=1)\n same => n,Set(__AIDA_TAKEOVER_RING_SECONDS=5)\n same => n,Goto(aida-takeover,bad!,1)\nexten => unguarded,1,Goto(aida-takeover,411,1)\nexten => normal,1,Dial(PJSIP/411,5)\n same => n,Hangup()\nexten => missing,1,Set(__AIDA_TAKEOVER=1)\n same => n,Set(__AIDA_TAKEOVER_RING_SECONDS=5)\n same => n,Goto(aida-takeover,999,1)\n[hold]\nexten => s,1,Wait(1)\n same => n,Hangup()\n');
  let output = '';
  const child = spawn(binary!, ['-f','-n','-vvv','-C',cfg], { stdio: ['ignore','pipe','pipe'] });
  child.stdout.on('data', b => { output += String(b); }); child.stderr.on('data', b => { output += String(b); });
  const stopped = new Promise<void>(resolve => child.on('close', () => resolve()));
  t.after(async () => { child.kill('SIGTERM'); await stopped; await rm(root, { recursive: true, force: true }); });
  const cli = async (cmd: string) => (await run(binary!, ['-C',cfg,'-rx',cmd], { timeout: 4000 })).stdout;
  for (let i = 0; i < 80 && !output.includes('Asterisk Ready'); i++) await delay(100);
  assert.ok(output.includes('Asterisk Ready'), output);
  const endpoint = await cli('pjsip show endpoint 411'); assert.match(endpoint, /411/, output);
  for (const name of ['unguarded','invalid','missing','guarded','normal']) {
    const offset = output.length; const before = invites.length;
    await cli(`channel originate Local/${name}@test extension s@hold`);
    await delay(150);
    for (let i = 0; i < 60 && !(await cli('core show channels count')).includes('0 active channels'); i++) await delay(100);
    const logs = output.slice(offset);
    assert.doesNotMatch(logs, /No application|Function .*not registered|syntax error/i);
    if (['unguarded','invalid','missing'].includes(name)) {
      assert.equal(invites.length, before, logs); assert.match(logs, name === 'missing' ? /Hangup\(.*"17"/ : /Hangup\(.*"21"/);
    } else {
      assert.ok(invites.length > before, logs + '\n' + endpoint + '\n' + output.slice(-9000));
      const invite = invites[before]!;
      if (name === 'guarded') assert.match(invite, /Call-Info: <sip:127\.0\.0\.1>;answer-after=0/i);
      else assert.doesNotMatch(invite, /Call-Info:|Alert-Info:/i);
      assert.doesNotMatch(invite, /Alert-Info:/i);
    }
  }
});
