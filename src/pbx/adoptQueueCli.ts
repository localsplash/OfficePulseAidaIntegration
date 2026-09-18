import { pathToFileURL } from 'node:url';
import { CONTEXT_RE, NAME_RE } from './managedDid.js';
import { queueMarkerData, queueMarkerExten } from './queueOwnership.js';

/** The reviewed marker INSERT that transfers a legacy queue to its owning context. Inputs are grammar-bound, so no SQL quoting is needed. */
export function adoptQueueStatement(context: string, queue: string): string {
  if (!CONTEXT_RE.test(context)) throw new Error('context must match ^[a-zA-Z0-9_.-]{1,40}$');
  if (!NAME_RE.test(queue)) throw new Error('queue must match ^[a-zA-Z0-9_.-]{1,80}$');
  return `INSERT INTO extensions (context, exten, priority, app, appdata) VALUES ('${context}', '${queueMarkerExten(queue)}', 1, 'NoOp', '${queueMarkerData(queue)}');`;
}

/** No database access: prints SQL for an operator to review and apply with their own asterisk account. Exit 2 on bad input. */
export function adoptQueueCli(argv: readonly string[]): { code: number; stdout: string; stderr: string } {
  const [context, queue, ...extra] = argv;
  if (!context || !queue || extra.length) return { code: 2, stdout: '', stderr: 'usage: npm run pbx:adopt-queue -- <context> <queue>\n' };
  try {
    const statement = adoptQueueStatement(context, queue);
    return { code: 0, stderr: '', stdout: [
      `-- Adopt legacy queue ${queue} into Asterisk context ${context} (OfficePulse queue ownership marker v1).`,
      '-- Review, then apply against the asterisk database with an operator account. Exactly one marker row may exist per queue:',
      '-- the same marker in any other context makes ownership ambiguous and the queue is then owned by nobody. Expect no rows here:',
      `SELECT context FROM extensions WHERE exten = '${queueMarkerExten(queue)}' AND priority = 1 AND app = 'NoOp' AND appdata = '${queueMarkerData(queue)}';`,
      statement, ''].join('\n') };
  } catch (error) { return { code: 2, stdout: '', stderr: `${(error as Error).message}\n` }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = adoptQueueCli(process.argv.slice(2));
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.code;
}
