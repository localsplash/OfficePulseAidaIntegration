import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const run = promisify(execFile);
const source = new URL('../asterisk/extensions_aida.conf', import.meta.url);

test('managed DID include has one versioned native path, validation, recording guard and bounded LiveKit fallback', async () => {
  const include = (await readFile(source, 'utf8')).split('[aida-managed-did-v1]')[1]!;
  assert.ok(include);
  for (const instruction of ['${ARGC} != 6', 'GotoIfTime(${ARG4},${ARG5},*,*,${ARG6}?queue:livekit)', 'Queue(${ARG1},r,,,$[${ARG2} * 5])', 'Dial(PJSIP/${ARG3}@livekit,60)', 'Hangup(21)', 'MIXMONITOR_FILENAME', 'CDR(userfield)', 'officepulse-recording']) assert.ok(include.includes(instruction), instruction);
  assert.doesNotMatch(include, /AGI\(|System\(|Stasis\(|retell|Queue\([^\n]*,c/);
  assert.equal((include.match(/Dial\(/g) ?? []).length, 1);
});

const binary = process.env.TEST_ASTERISK_BINARY;
test('isolated Asterisk exercises schedule, answer, timeout and unavailable/malformed paths without SIP/network modules', { skip: !binary, timeout: 45_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'aida-dialplan-test-'));
  const cfg = join(root, 'asterisk.conf');
  let output = '';
  for (const folder of ['run', 'log', 'spool', 'data', 'cache']) await mkdir(join(root, folder));
  await writeFile(cfg, `[directories]\nastetcdir => ${root}\nastmoddir => ${process.env.TEST_ASTERISK_MODULE_DIR ?? '/usr/lib/asterisk/modules'}\nastvarlibdir => ${root}/data\nastdbdir => ${root}/data\nastkeydir => ${root}/data\nastdatadir => ${process.env.TEST_ASTERISK_DATA_DIR ?? '/var/lib/asterisk'}\nastagidir => ${root}/data\nastspooldir => ${root}/spool\nastrundir => ${root}/run\nastlogdir => ${root}/log\nastcachedir => ${root}/cache\n[options]\nverbose = 4\n`);
  await writeFile(join(root, 'modules.conf'), `[modules]\nautoload=no\n${['res_timing_timerfd', 'res_clioriginate', 'bridge_simple', 'bridge_holding', 'bridge_builtin_features', 'res_musiconhold', 'func_strings', 'func_logic', 'func_env', 'func_cdr', 'func_dialplan', 'app_stack', 'app_dial', 'app_queue', 'app_originate', 'app_verbose', 'pbx_config'].map(module => `load=${module}.so`).join('\n')}\n`);
  await writeFile(join(root, 'logger.conf'), '[general]\n[logfiles]\nconsole => notice,warning,error,verbose\n');
  await writeFile(join(root, 'manager.conf'), '[general]\nenabled=no\n');
  await writeFile(join(root, 'http.conf'), '[general]\nenabled=no\n');
  await writeFile(join(root, 'cdr.conf'), '[general]\nenable=yes\n');
  await writeFile(join(root, 'queues.conf'), '[general]\npersistentmembers=no\n[test-answer]\nstrategy=ringall\nmember=Local/answer@pbx-test-agent\n[test-timeout]\nstrategy=ringall\ntimeout=1\nretry=1\njoinempty=yes\nleavewhenempty=no\nmember=Local/unanswered@pbx-test-agent\n');
  const day = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date().getUTCDay()]!;
  const outside = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][(new Date().getUTCDay() + 1) % 7]!;
  await writeFile(join(root, 'extensions.conf'), `${await readFile(source, 'utf8')}\n[pbx-test]\n` + [
    ['missing', 'missing,1,+15555550101,*,*,UTC'],
    ['inside', `missing,1,+15555550101,00:00-23:59,${day},UTC`],
    ['outside', `test-timeout,1,+15555550101,00:00-23:59,${outside},UTC`],
    ['timeout', 'test-timeout,1,+15555550101,*,*,UTC'],
    ['answered', 'test-answer,1,+15555550101,*,*,UTC'],
    ['invalid', 'test-answer,0,+15555550101,*,*,UTC'],
    ['badzone', 'test-answer,1,+15555550101,00:00-23:59,mon,Unknown/Zone'],
  ].map(([name, args]) => `exten => ${name},1,Gosub(aida-managed-did-v1,s,1(${args}))\n same => n,Hangup()`).join('\n') + '\n[pbx-test-agent]\nexten => answer,1,Answer()\n same => n,Wait(1)\n same => n,Hangup()\nexten => unanswered,1,Ringing()\n same => n,Wait(10)\n same => n,Hangup()\n[pbx-test-caller]\nexten => hold,1,Wait(2)\n same => n,Hangup()\n');
  const child = spawn(binary!, ['-f', '-n', '-vvv', '-C', cfg], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  const stopped = new Promise<void>(resolve => child.on('close', () => resolve()));
  t.after(async () => { child.kill('SIGTERM'); await stopped; await rm(root, { recursive: true, force: true }); });
  const cli = async (command: string) => (await run(binary!, ['-C', cfg, '-rx', command], { timeout: 4000 })).stdout;
  for (let i = 0; i < 60 && !output.includes('Asterisk Ready'); i++) { if (child.exitCode !== null) break; await delay(100); }
  assert.ok(output.includes('Asterisk Ready'), output);
  assert.match(await cli('dialplan show aida-managed-did-v1'), /GotoIfTime/);
  for (const name of ['missing', 'inside', 'outside', 'timeout', 'answered', 'invalid', 'badzone']) {
    const offset = output.length;
    const start = Date.now();
    const commandResult = await cli(`channel originate Local/${name}@pbx-test extension hold@pbx-test-caller`);
    assert.doesNotMatch(commandResult, /No such command|Unable|Failed/i);
    await delay(150);
    for (let i = 0; i < 100; i++) {
      if ((await cli('core show channels count')).includes('0 active channels')) break;
      await delay(100);
    }
    const log = output.slice(offset);
    assert.doesNotMatch(log, /No application|Function .* not registered|syntax error/i, log);
    if (name === 'invalid' || name === 'badzone') { assert.doesNotMatch(log, /Executing .* (Queue|Dial)\(/); assert.match(log, /Hangup\(.*"21"/); }
    else if (name === 'answered') { assert.match(log, /answered/); assert.doesNotMatch(log, /Dial\(.*PJSIP/); }
    else {
      assert.match(log, /Dial\(.*PJSIP\/\+15555550101@livekit,60/);
      if (name === 'outside') assert.doesNotMatch(log, /Executing .* Queue\(/);
      else assert.match(log, /Executing .* Queue\(/);
      if (name === 'timeout') assert.ok(Date.now() - start >= 4500, 'one ring grants approximately five seconds');
    }
  }
});

test('installation contract maps the six native Realtime families and requires narrow operator delegation', async () => {
  const mapping = await readFile(new URL('../asterisk/extconfig.conf.template', import.meta.url), 'utf8');
  for (const table of ['ps_endpoints', 'ps_auths', 'ps_aors', 'extensions', 'queues', 'queue_members']) {
    assert.ok(mapping.includes(`${table} => mysql,asterisk,${table}`));
  }
  const runbook = await readFile(new URL('../docs/PBX_PROVISIONING.md', import.meta.url), 'utf8');
  for (const requirement of ['include it once', 'Do not install a catch-all Realtime switch', '+19496501147', 'queue show concierge', 'pjsip show endpoint livekit', 'recording', 'Rollback'.toLowerCase()]) assert.ok(runbook.includes(requirement), requirement);
});
