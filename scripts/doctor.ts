import { randomUUID } from 'node:crypto';
import { Session } from '../src/session.ts';
import { requestSchema } from '../src/protocol.ts';
import { stateDir } from '../src/server.ts';
import { join } from 'node:path';

const session = new Session(join(stateDir, 'checks'), randomUUID());
const timeout = setTimeout(() => session.cancel(), 90_000);
try {
  const model = process.argv[2] ?? 'claude-opus-5-5';
  await session.accept(requestSchema.parse({ model, stream: true, reasoning: { effort: 'low' }, input: [{ type:'message',role:'user',content:'Reply with exactly ADAPTER_OK.' }] }));
  let output = '';
  while (true) {
    const event = await session.next();
    if (event.type === 'text') output += event.text;
    if (event.type === 'error') throw event.error;
    if (event.type === 'tool') throw Error('A text-only check unexpectedly requested a tool.');
    if (event.type === 'done') {
      if (output.trim() !== 'ADAPTER_OK') throw Error(`Unexpected check response: ${output}`);
      console.log(`Subscription request succeeded on ${model}.`);
      console.log(JSON.stringify({ usage: event.usage }));
      break;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally { clearTimeout(timeout); session.cancel(); await session.task; }
