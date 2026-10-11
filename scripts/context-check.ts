import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Session } from '../src/session.ts';
import { requestSchema } from '../src/protocol.ts';
import { stateDir } from '../src/server.ts';

const count = Number(process.argv[2] ?? 250_000);
assert.ok(Number.isInteger(count) && count >= 1000 && count <= 900_000, 'Supply 1,000–900,000 filler words. This consumes subscription allowance.');
const early = randomUUID();
const late = randomUUID();
const session = new Session(join(stateDir, 'checks'), randomUUID());
const timeout = setTimeout(() => session.cancel(), 600_000);
try {
  await session.accept(requestSchema.parse({ model: 'claude-opus-5-5', stream: true, reasoning: { effort: 'low' },
    input: [{ type: 'message', role: 'user', content: `Read this synthetic document and return the exact values of early_key and late_key, with no other text.\nearly_key=${early}\n${' tree'.repeat(count)}\nlate_key=${late}` }] }));
  let output = '';
  for (;;) {
    const event = await session.next();
    if (event.type === 'text') output += event.text;
    if (event.type === 'error') throw event.error;
    if (event.type === 'tool') throw new Error('Unexpected tool call.');
    if (event.type === 'done') {
      assert.ok(output.includes(early) && output.includes(late), 'Long-context retrieval failed.');
      console.log(JSON.stringify({ fillerWords: count, retrieval: 'passed', usage: event.usage }));
      break;
    }
  }
} finally { clearTimeout(timeout); session.cancel(); await session.task; }
