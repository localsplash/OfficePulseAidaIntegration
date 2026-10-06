import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptQueueCli, adoptQueueStatement } from '../src/pbx/adoptQueueCli.js';
import { queueMarkerExten, recognizedQueueMarker } from '../src/pbx/queueOwnership.js';

test('the adoption statement is the exact versioned marker row for the context and needs no database access', () => {
  const statement = adoptQueueStatement('tenant-seven', 'concierge');
  assert.equal(statement, `INSERT INTO extensions (context, exten, priority, app, appdata) VALUES ('tenant-seven', '${queueMarkerExten('concierge')}', 1, 'NoOp', 'OfficePulse:queue:v1:concierge');`);
  const [, exten, appdata] = /VALUES \('tenant-seven', '([^']+)', 1, 'NoOp', '([^']+)'\);$/.exec(statement)!;
  assert.equal(recognizedQueueMarker(exten!, appdata!), 'concierge');
  assert.equal(exten!.length, 40);
  for (const [context, queue] of [['bad ctx', 'q'], ["x'; DROP TABLE extensions; --", 'q'], ['ctx', "q'"], ['x'.repeat(41), 'q'], ['ctx', 'x'.repeat(81)], ['', 'q'], ['ctx', '']]) {
    assert.throws(() => adoptQueueStatement(context!, queue!), /must match/, `${context} ${queue}`);
  }
});

test('the CLI prints a review query and the statement, and exits 2 on bad input without printing SQL', () => {
  const ok = adoptQueueCli(['tenant-seven', 'concierge']);
  assert.equal(ok.code, 0); assert.equal(ok.stderr, '');
  assert.match(ok.stdout, /^-- Adopt legacy queue concierge into Asterisk context tenant-seven/);
  assert.ok(ok.stdout.includes(`SELECT context FROM extensions WHERE exten = '${queueMarkerExten('concierge')}'`));
  assert.ok(ok.stdout.trimEnd().endsWith(adoptQueueStatement('tenant-seven', 'concierge')));
  for (const argv of [[], ['tenant-seven'], ['tenant-seven', 'concierge', 'extra'], ['bad ctx', 'concierge'], ['tenant-seven', 'bad queue']]) {
    const result = adoptQueueCli(argv);
    assert.equal(result.code, 2, argv.join(' ')); assert.equal(result.stdout, ''); assert.ok(result.stderr.length);
    assert.doesNotMatch(result.stderr, /INSERT/);
  }
  assert.match(adoptQueueCli([]).stderr, /usage: npm run pbx:adopt-queue -- <context> <queue>/);
});
