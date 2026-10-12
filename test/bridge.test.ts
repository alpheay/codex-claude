import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { query, type Query, type SDKMessage, type Options } from '@anthropic-ai/claude-agent-sdk';
import { bridgeServer } from '../src/server.ts';
import { Session, subscriptionEnvironment } from '../src/session.ts';
import { historyContent, modelContent, requestSchema, ResponseStream, toolResult, toolsFor, digest, instructionsFor, userMessages, type Item } from '../src/protocol.ts';
import { turnMetadata } from '../src/protocol.ts';
import { configure, restore } from '../scripts/setup.ts';
import { parse } from 'smol-toml';

const tool = { type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec', description: 'Execute code', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } }] };
const first = { model: 'claude-opus-5-5', stream: true, input: [{ type: 'additional_tools', role: 'developer', tools: [tool] }, { type: 'message', role: 'user', content: 'Read the file.' }] };
const parsed = requestSchema.parse(first);

test('tool namespaces and custom input constraints survive translation', () => {
  const [t] = toolsFor(parsed);
  assert.equal(t.namespace, 'functions');
  assert.equal(t.kind, 'custom');
  assert.match(t.description, /start:/);
  assert.equal((t.schema.properties as Record<string, {type: string}>).input.type, 'string');
  assert.notEqual(t.key, toolsFor(requestSchema.parse({ ...first, tools: [{ type:'function', name:'exec', parameters:{type:'object'} }], input: [] }))[0].key);
  assert.deepEqual(toolsFor(requestSchema.parse({ ...first, tools: [{ type: 'web_search' }] })), toolsFor(parsed));
});

function fakeFactory(account = { apiProvider: 'firstParty', subscriptionType: 'max', apiKeySource: 'none' }, toolCalls = true, expectedResult: unknown = [{ type: 'text', text: 'FILE_CONTENT' }], keepAlive = false) {
  const recorded: Options[] = [];
  const prompts: unknown[] = [];
  const factory: typeof query = ({ prompt, options = {} }) => {
    recorded.push(options);
    let client: Client | undefined;
    let closed = false;
    const received: unknown[] = [];
    const replays: SDKMessage[] = [];
    let wake: (() => void) | undefined;
    let receiveFirst!: () => void;
    const firstInput = new Promise<void>(resolve => { receiveFirst = resolve; });
    assert.notEqual(typeof prompt, 'string');
    const inputPump = (async () => {
      for await (const message of prompt) {
        assert.ok(typeof message !== 'string');
        prompts.push(message.message.content);
        received.push(message.message.content);
        replays.push({ ...message, isReplay: true, session_id: 'fake-session' } as SDKMessage);
        receiveFirst(); wake?.();
      }
    })();
    const generator = (async function* (): AsyncGenerator<SDKMessage> {
      await firstInput;
      assert.deepEqual(options.tools, []);
      assert.equal(options.permissionMode, 'dontAsk');
      yield { type: 'system', subtype: 'init', session_id: 'fake-session' } as SDKMessage;
      if (!options.resume && toolCalls) {
        const config = options.mcpServers!.codex;
        assert.equal(config.type, 'sdk');
        if (config.type !== 'sdk') throw Error('Expected SDK tool server');
        const [a,b] = InMemoryTransport.createLinkedPair();
        client = new Client({ name: 'check', version: '1' });
        await Promise.all([config.instance.connect(a), client.connect(b)]);
        const { tools } = await client.listTools();
        const invalid = await client.callTool({ name: tools[0].name, arguments: { input: 123 } });
        assert.equal(invalid.isError, true);
        const result = await client.callTool({ name: tools[0].name, arguments: { input: 'text(await tools.exec_command({cmd:"cat sample.txt"}));' } });
        assert.deepEqual(result.content, expectedResult);
      }
      if (closed) return;
      while (replays.length) yield replays.shift()!;
      if (received.length > 1) yield { type: 'result', subtype: 'success', is_error: false, result: '', queued_turn_count: 1 } as SDKMessage;
      yield { type:'stream_event', event:{ type:'content_block_delta', index:0, delta:{type:'text_delta',text:options.resume ? 'FOLLOW_UP' : 'FILE_CONTENT'} } } as SDKMessage;
      while (replays.length) yield replays.shift()!;
      yield { type:'result', subtype:'success', is_error:false, result:'FILE_CONTENT' } as SDKMessage;
      while (keepAlive && !closed) {
        await new Promise<void>(resolve => { wake = resolve; });
        if (closed) return;
        while (replays.length) yield replays.shift()!;
        yield { type:'stream_event', event:{ type:'content_block_delta', index:0, delta:{type:'text_delta',text:'WARM_FOLLOW_UP'} } } as SDKMessage;
        yield { type:'result', subtype:'success', is_error:false, result:'WARM_FOLLOW_UP' } as SDKMessage;
      }
      return;
    })();
    return Object.assign(generator, { accountInfo: async()=>account, setModel: async(model: string)=>{ options.model = model; }, close:()=>{ closed=true; wake?.(); void client?.close(); } }) as unknown as Query;
  };
  return { factory, recorded, prompts };
}

async function events(response: Response) {
  const body = await response.text();
  assert.equal(response.status,200,body);
  return body.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
}

test('long tool waits survive cleanup, resume once, and still expire when abandoned', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const dir = await mkdtemp(join(tmpdir(), 'codex-claude-wait-'));
  const fake = fakeFactory();
  const created: Session[] = [];
  const server = bridgeServer('token', dir, key => {
    const session = new Session(dir, key, fake.factory);
    created.push(session);
    return session;
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.close(); server.closeAllConnections();
    await Promise.all(created.map(session => session.task));
    t.mock.timers.reset();
    await rm(dir, { recursive: true, force: true });
  });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: 'Bearer token', 'content-type': 'application/json', 'session-id': 'wait' };
  const send = (input: unknown[], key = 'wait') => fetch(`${url}/v1/responses`, { method: 'POST', headers: { ...headers, 'session-id': key }, body: JSON.stringify({ ...first, input }) });
  const count = async () => {
    const health = await (await fetch(`${url}/health`, { headers })).json();
    assert.ok(health && typeof health === 'object' && 'sessions' in health);
    return health.sessions;
  };
  const start = await events(await send(first.input));
  const call = start.at(-1).response.output[0];
  assert.equal(created[0].inRequest, false);
  assert.equal(created[0].pending.size, 1);
  t.mock.timers.tick(2 * 60 * 60 * 1000);
  assert.equal(await count(), 1, 'an outstanding tool must survive ten-minute idle cleanup');
  assert.equal(created[0].aborted, false);
  assert.equal(fake.recorded[0].mcpServers!.codex.timeout, 24 * 60 * 60 * 1000);
  const result = await events(await send([...first.input, call, { type: 'custom_tool_call_output', call_id: call.call_id, output: 'FILE_CONTENT' }]));
  assert.ok(result.some(e => e.type === 'response.output_text.delta' && e.delta === 'FILE_CONTENT'));
  await created[0].task;
  assert.equal(fake.recorded.length, 1, 'waiting must preserve the existing SDK query');
  assert.equal(created[0].pending.size, 0);
  t.mock.timers.tick(11 * 60 * 1000);
  assert.equal(await count(), 0, 'finished sessions still expire');

  await events(await send(first.input, 'abandoned'));
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal(await count(), 0, 'abandoned tools have a bounded lifetime');
  assert.equal(created[1].aborted, true);
  await created[1].task;

  await events(await send(first.input, 'cancelled'));
  created[2].cancel();
  await created[2].task;
  assert.equal(created[2].pending.size, 0);
  t.mock.timers.tick(11 * 60 * 1000);
  assert.equal(await count(), 0, 'cancellation does not retain a session for a day');
});

test('HTTP and MCP tool handoff, completion, authentication, isolation, and restart', async t => {
  const dir = await mkdtemp(join(tmpdir(),'codex-claude-check-'));
  const fake = fakeFactory();
  const server = bridgeServer('test-token', dir, key=>new Session(dir,key,fake.factory));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{ server.close(); server.closeAllConnections(); await rm(dir,{recursive:true,force:true}); });
  const address=server.address(); assert.ok(address && typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}`;
  const send=(body:unknown,key='one')=>fetch(`${url}/v1/responses`,{method:'POST',headers:{authorization:'Bearer test-token','session-id':key,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await fetch(`${url}/health`)).status,401);
  assert.equal((await fetch(`${url}/health`,{headers:{authorization:'Bearer test-token',origin:'https://example.com'}})).status,401);
  assert.equal((await send({...first,stream:false})).status,400);
  const start=await events(await send(first));
  const response=start.find(e=>e.type==='response.completed').response;
  const call=response.output[0];
  assert.equal(call.type,'custom_tool_call'); assert.equal(call.namespace,'functions'); assert.equal(call.name,'exec');
  const midTurn=await send({...first,model:'claude-sonnet-5-5'});
  assert.equal(midTurn.status,409);
  assert.match(await midTurn.text(), /outstanding Codex tool call/);
  const second=await events(await send({...first,model:'claude-sonnet-5-5',tools:[{type:'function',name:'lateConnector',parameters:{type:'object'}}],input:[...first.input,call,{type:'custom_tool_call_output',call_id:call.call_id,output:[{type:'input_text',text:'FILE_CONTENT'}]}]}));
  assert.equal(fake.recorded[0].model, 'claude-sonnet-5-5');
  assert.ok(second.some(e=>e.type==='response.output_text.delta'&&e.delta==='FILE_CONTENT'));
  assert.equal(second.at(-1).type,'response.completed');
  const isolated=await events(await send(first,'two'));
  assert.equal(isolated.at(-1).response.output[0].type,'custom_tool_call');
  const restart=new Session(dir,'one',fake.factory);
  await restart.accept(requestSchema.parse({...first,model:'claude-sonnet-5-5',instructions:'Updated permissions',input:[...first.input,{type:'message',role:'user',content:'Continue.'}]}));
  assert.equal((await restart.next()).type,'text');
  assert.equal((await restart.next()).type,'done');
  assert.equal(fake.recorded.at(-1)?.resume,'fake-session');
  assert.equal(fake.recorded.at(-1)?.model,'claude-sonnet-5-5');
  assert.equal(restart.state?.model,'claude-sonnet-5-5');
  const system = fake.recorded.at(-1)?.systemPrompt;
  assert.ok(system && typeof system === 'object' && !Array.isArray(system) && system.type === 'custom');
  assert.equal(system.snapshot, false);
  assert.ok(typeof system.prompt === 'string');
  assert.match(system.prompt, /^Updated permissions\n\n/);
  restart.inRequest=false;
  restart.factory = fakeFactory(undefined, false).factory;
  await restart.accept(requestSchema.parse({...first,input:[{type:'message',role:'user',content:'Different history'}]}));
  assert.equal((await restart.next()).type, 'text');
  assert.equal((await restart.next()).type, 'done');
  await restart.task;
});

test('subagents sharing a transport session have independent Claude sessions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-claude-agents-'));
  const fake = fakeFactory();
  const server = bridgeServer('token', dir, key => new Session(dir, key, fake.factory));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.close(); server.closeAllConnections(); await rm(dir, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const send = (thread: string, input = first.input) => fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer token', 'session-id': 'shared-parent', 'x-codex-turn-metadata': JSON.stringify({ thread_id: thread, session_id: 'shared-parent', ...(thread === 'parent' ? {} : { parent_thread_id: 'parent' }) }) }, body: JSON.stringify({ ...first, input }) });
  const parent = await events(await send('parent'));
  const child = await events(await send('child'));
  assert.notEqual(parent.at(-1).response.output[0].call_id, child.at(-1).response.output[0].call_id);
  assert.equal(fake.recorded.length, 2);
  await events(await send('inherited-child', [...first.input, { type: 'message', role: 'assistant', content: 'Completed parent action: PARENT_RESULT' }, { type: 'message', role: 'user', content: 'Research the next step.' }]));
  assert.ok(String(fake.prompts.at(-1)).includes('PARENT_RESULT'));
  assert.equal(fake.recorded.at(-1)?.resume, undefined);
});

test('manual forks import only their branch history into an independent session', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-claude-fork-'));
  const fake = fakeFactory(undefined, false);
  const server = bridgeServer('token', dir, key => new Session(dir, key, fake.factory));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.close(); server.closeAllConnections(); await rm(dir, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const send = (thread: string, input: unknown[], source?: string) => fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer token', 'session-id': thread, 'x-codex-turn-metadata': JSON.stringify({ thread_id: thread, forked_from_thread_id: source }) }, body: JSON.stringify({ ...first, input }) });
  await events(await send('parent', first.input));
  const branch = [...first.input, { type: 'message', role: 'assistant', content: 'BRANCH_RESULT' }];
  await events(await send('parent', [...branch, { type: 'message', role: 'user', content: 'PARENT_ONLY' }]));
  await events(await send('fork', [...branch, { type: 'message', role: 'user', content: 'Continue the branch.' }], 'parent'));
  assert.equal(fake.recorded.at(-1)?.resume, undefined);
  assert.match(String(fake.prompts.at(-1)), /BRANCH_RESULT/);
  assert.doesNotMatch(String(fake.prompts.at(-1)), /PARENT_ONLY/);
  await events(await send('fork', [...branch, { type: 'message', role: 'user', content: 'Continue the branch.' }, { type: 'message', role: 'user', content: 'Follow up.' }], 'parent'));
  assert.equal(fake.recorded.at(-1)?.resume, 'fake-session');
  assert.equal(fake.prompts.at(-1), 'Follow up.');
  assert.equal((await send('unrelated', branch)).status, 409);
});

test('images reach the SDK as native blocks in messages, tool results, and fork history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-claude-image-'));
  const image = { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' };
  const content = [{ type: 'input_text', text: 'Inspect this screenshot.' }, image];
  const result = toolResult(content);
  const fake = fakeFactory(undefined, true, result.content);
  const session = new Session(dir, 'image', fake.factory);
  try {
    const input: Item[] = [...first.input, { type: 'message', role: 'user', content }];
    await session.accept(requestSchema.parse({ ...first, input }));
    const call = await session.next(); assert.equal(call.type, 'tool');
    if (call.type !== 'tool') throw Error('Expected tool');
    const blocks = modelContent(content); assert.ok(Array.isArray(blocks));
    assert.deepEqual(fake.prompts[0], [{ type: 'text', text: 'Read the file.' }, ...blocks]);
    session.inRequest = false;
    input.push({ type: 'custom_tool_call_output', call_id: call.callId, output: content });
    await session.accept(requestSchema.parse({ ...first, input }));
    assert.equal((await session.next()).type, 'text');
    assert.equal((await session.next()).type, 'done');
    await session.task;
    const history = historyContent(input);
    assert.ok(Array.isArray(history));
    assert.equal(history.filter(b => b.type === 'image').length, 2);
    assert.doesNotMatch(JSON.stringify(history[0]), /aW1hZ2U=/);
    assert.deepEqual(result.content[1], { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' });
    assert.throws(() => modelContent([{ ...image, image_url: 'data:image/svg+xml;base64,aW1hZ2U=' }]), /Images must be embedded/);
    assert.throws(() => modelContent([{ ...image, image_url: 'data:image/png;base64,invalid' }]), /Images must be embedded/);
    assert.throws(() => modelContent([{ type: 'input_audio' }]), /Unsupported content type/);
  } finally { session.cancel(); await session.task; await rm(dir, { recursive: true, force: true }); }
});

test('subagent notifications can arrive with a pending tool result', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-claude-notify-'));
  const fake = fakeFactory();
  const server = bridgeServer('token', dir, key => new Session(dir, key, fake.factory));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.close(); server.closeAllConnections(); await rm(dir, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const send = (input: unknown[]) => fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer token', 'session-id': 'parent' }, body: JSON.stringify({ ...first, input }) });
  const start = await events(await send(first.input));
  const call = start.at(-1).response.output[0];
  const notification = '<subagent_notification>{"agent_path":"child","status":{"completed":"CHILD_OK"}}</subagent_notification>';
  const result = await events(await send([...first.input, call, { type: 'custom_tool_call_output', call_id: call.call_id, output: 'FILE_CONTENT' }, { type: 'message', role: 'user', content: notification }]));
  assert.equal(result.at(-1).type, 'response.completed');
  assert.ok(result.some(e => e.type === 'response.output_text.delta' && e.delta === 'FILE_CONTENT'));
  assert.ok(fake.prompts.includes(notification));
  await events(await send([...first.input, { type: 'message', role: 'user', content: notification }, { type: 'message', role: 'user', content: 'Continue.' }]));
  assert.equal(fake.prompts.at(-1), 'Continue.');
  assert.equal(fake.prompts.filter(p => p === notification).length, 1);
});

test('a Claude model switch waits for the previous SDK query to close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-claude-switch-'));
  const fake = fakeFactory(undefined, false, undefined, true);
  let release!: () => void;
  const closing = new Promise<void>(resolve => { release = resolve; });
  const factory: typeof query = args => {
    const q = fake.factory(args);
    if (fake.recorded.length === 1) {
      const close = q.close.bind(q);
      q.close = () => { void closing.then(close); };
    }
    return q;
  };
  const session = new Session(dir, 'switch', factory);
  try {
    await session.accept(parsed);
    assert.equal((await session.next()).type, 'text');
    assert.equal((await session.next()).type, 'done');
    session.inRequest = false;
    const next = session.accept(requestSchema.parse({ ...first, model: 'claude-sonnet-5-5', input: [...first.input, { type: 'message', role: 'user', content: 'Continue.' }] }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.state?.model, 'claude-opus-5-5');
    release();
    await next;
    assert.equal((await session.next()).type, 'text');
    assert.equal((await session.next()).type, 'done');
    assert.equal(fake.recorded.at(-1)?.resume, 'fake-session');
    assert.equal(fake.recorded.at(-1)?.model, 'claude-sonnet-5-5');
  } finally { release(); session.cancel(); await session.task; await rm(dir, { recursive: true, force: true }); }
});

test('compaction uses a separate session and new windows import the summary once', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-claude-compact-'));
  const fake = fakeFactory(undefined, false, undefined, true);
  const sessions: Session[] = [];
  const server = bridgeServer('token', dir, key => { const s = new Session(dir, key, fake.factory); sessions.push(s); return s; });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const s of sessions) s.cancel(); server.close(); server.closeAllConnections(); await Promise.all(sessions.map(s => s.task)); await rm(dir, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const send = (input: unknown[], kind: string, window: number) => fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer token', 'session-id': 'compact-chat' }, body: JSON.stringify({ ...first, input, client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ request_kind: kind, window_number: window }) } }) });
  await events(await send(first.input, 'turn', 0));
  const history = [...first.input, { type: 'message', role: 'assistant', content: 'The completed action produced KEEP_THIS.' }, { type: 'message', role: 'user', content: 'Summarize the conversation.' }];
  await events(await send(history, 'compaction', 0));
  await sessions[1].task;
  assert.equal(sessions[1].running, false, 'transient compaction queries must not remain idle');
  assert.equal(fake.recorded.at(-1)?.resume, undefined);
  assert.ok(String(fake.prompts.at(-1)).includes('KEEP_THIS'));
  const compacted = [{ type: 'message', role: 'user', content: 'Summary: KEEP_THIS' }, { type: 'message', role: 'user', content: 'Continue.' }];
  await events(await send(compacted, 'turn', 1));
  assert.equal(fake.recorded.at(-1)?.resume, undefined);
  await events(await send([...compacted, { type: 'message', role: 'user', content: 'One more turn.' }], 'turn', 1));
  assert.equal(fake.recorded.length, 3, 'the compacted window reuses its completed query');
  assert.equal(fake.prompts.at(-1), 'One more turn.');
  assert.throws(() => turnMetadata(parsed, '{broken'), /Invalid Codex turn metadata/);
});

test('provider switch and rollback preserve unrelated settings and later edits', () => {
  const original = 'model = "gpt-original"\nservice_tier = "priority"\n[features]\njs_repl = true\n[model_providers.existing]\nname = "Keep me"\n';
  const configured = configure(original, 'test-local-key');
  assert.equal(parse(configured).model_provider, 'subscription-router');
  const provider = (parse(configured).model_providers as Record<string, Record<string, unknown>>)['subscription-router'];
  assert.equal(provider.request_max_retries, 8);
  assert.equal(provider.stream_max_retries, 0);
  assert.deepEqual(parse(restore(configured, original)), parse(original));
  const changed = configured.replace('js_repl = true', 'js_repl = false');
  assert.deepEqual(parse(restore(changed, original)), parse(original.replace('js_repl = true', 'js_repl = false')));
});

test('late streaming cache usage contributes to the actual context size', () => {
  const session = new Session('/unused', 'usage');
  session.updateUsage({ input_tokens: 2, output_tokens: 0 });
  session.updateUsage({ input_tokens: null, output_tokens: 40, cache_read_input_tokens: 850_000 });
  assert.deepEqual(session.usage, { input_tokens: 850_002, output_tokens: 40, cached_tokens: 850_000 });
});

test('API authentication is rejected before a model prompt is sent', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'codex-claude-auth-'));
  try {
    const fake=fakeFactory({apiProvider:'firstParty',subscriptionType:'',apiKeySource:'environment'});
    const session=new Session(dir,'auth',fake.factory);
    await session.accept(parsed);
    const event=await session.next();
    assert.equal(event.type,'error');
    if(event.type==='error') assert.match(event.error.message,/subscription authentication/);
    await session.task;
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('interrupted chats recover from visible history without resuming a pending SDK action',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'codex-claude-cancel-'));
  try {
    const fake=fakeFactory();
    const session=new Session(dir,'cancel',fake.factory);
    await session.accept(parsed);
    assert.equal((await session.next()).type,'tool');
    session.cancel();session.inRequest=false;
    await session.task;
    const recovery = fakeFactory(undefined, false);
    const reopened=new Session(dir,'cancel',recovery.factory);
    const history = requestSchema.parse({ ...first, input: [...first.input, { type: 'custom_tool_call', call_id: 'old-call', name: 'exec', input: 'already executed action' }, { type: 'custom_tool_call_output', call_id: 'old-call', output: 'COMPLETED_ACTION_RESULT' }, { type: 'message', role: 'user', content: 'Continue after stopping.' }] });
    await reopened.accept(history);
    assert.equal((await reopened.next()).type, 'text');
    assert.equal((await reopened.next()).type, 'done');
    await reopened.task;
    assert.equal(recovery.recorded[0].resume, undefined);
    assert.match(String(recovery.prompts[0]), /COMPLETED_ACTION_RESULT/);
    session.factory = recovery.factory;
    await session.accept(history);
    assert.equal((await session.next()).type, 'text');
    assert.equal((await session.next()).type, 'done');
    await session.task;
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('new messages and permission changes can replace a pending tool turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-claude-recover-'));
  try {
    for (const permissionsChanged of [false, true]) {
      const session = new Session(dir, String(permissionsChanged), fakeFactory().factory);
      await session.accept(parsed);
      const call = await session.next(); assert.equal(call.type, 'tool');
      if (call.type !== 'tool') throw Error('Expected tool');
      const recovery = fakeFactory(undefined, false);
      session.factory = recovery.factory;
      session.inRequest = false;
      await session.accept(requestSchema.parse({ ...first, instructions: permissionsChanged ? 'Changed permissions.' : undefined, input: [...first.input, { type: 'custom_tool_call', call_id: call.callId, name: 'exec', input: 'pending action' }, ...(permissionsChanged ? [{ type: 'custom_tool_call_output', call_id: call.callId, output: 'COMPLETED' }] : [{ type: 'message', role: 'user', content: 'Stop that action and answer this instead.' }])] }));
      assert.equal((await session.next()).type, 'text');
      assert.equal((await session.next()).type, 'done');
      await session.task;
      assert.equal(recovery.recorded[0].resume, undefined);
      assert.match(String(recovery.prompts[0]), /unknown outcome/);
      assert.equal(session.pending.size, 0);
      if (permissionsChanged) assert.match(String(recovery.prompts[0]), /COMPLETED/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('subscription environment drops provider and API overrides without mutating the parent',()=>{
  process.env.ANTHROPIC_API_KEY='synthetic-test-key';
  process.env.CLAUDE_CODE_USE_BEDROCK='1';
  try {
    const env=subscriptionEnvironment();
    assert.equal(env.ANTHROPIC_API_KEY,undefined);
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK,undefined);
    assert.equal(process.env.ANTHROPIC_API_KEY,'synthetic-test-key');
  } finally { delete process.env.ANTHROPIC_API_KEY;delete process.env.CLAUDE_CODE_USE_BEDROCK; }
});

test('quiet responses send real SSE heartbeat events', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const dir = await mkdtemp(join(tmpdir(), 'codex-heartbeat-'));
  let release!: () => void;
  const quiet = new Promise<void>(r => { release = r; });
  const fake = fakeFactory(undefined, false);
  const factory: typeof query = args => {
    const q = fake.factory(args);
    const next = q.next.bind(q);
    q.next = async (...args) => {
      const event = await next(...args);
      if (!event.done && event.value.type === 'stream_event') await quiet;
      return event;
    };
    return q;
  };
  const server = bridgeServer('token', dir, key => new Session(dir, key, factory));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { release(); server.close(); server.closeAllConnections(); t.mock.timers.reset(); await rm(dir, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer token', 'session-id': 'quiet', 'content-type': 'application/json' }, body: JSON.stringify(first) });
  const reader = response.body!.getReader();
  let initial = new TextDecoder().decode((await reader.read()).value);
  while (!initial.includes('event: response.in_progress')) initial += new TextDecoder().decode((await reader.read()).value);
  const id = JSON.parse(initial.split('\n').find(l => l.startsWith('data: '))!.slice(6)).response.id;
  t.mock.timers.tick(15_000);
  const heartbeat = new TextDecoder().decode((await reader.read()).value);
  assert.match(heartbeat, /event: response.in_progress/);
  const event = JSON.parse(heartbeat.split('\n').find(l => l.startsWith('data: '))!.slice(6));
  assert.equal(event.response.id, id);
  assert.equal(event.response.status, 'in_progress');
  assert.equal(event.sequence_number, 2);
  release();
  while (!(await reader.read()).done) {}
});

test('reconnection after a tool result keeps the SDK query and replays stable response IDs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-reconnect-'));
  let release!: () => void;
  const quiet = new Promise<void>(r => { release = r; });
  const fake = fakeFactory();
  const factory: typeof query = args => {
    const q = fake.factory(args);
    const next = q.next.bind(q);
    q.next = async (...args) => {
      const event = await next(...args);
      if (!event.done && event.value.type === 'stream_event') await quiet;
      return event;
    };
    return q;
  };
  const sessions: Session[] = [];
  const server = bridgeServer('token', dir, key => { const s = new Session(dir, key, factory); sessions.push(s); return s; });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { release(); server.close(); server.closeAllConnections(); await Promise.all(sessions.map(s => s.task)); await rm(dir, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let attempt = 0;
  const send = (input: unknown[], instructions?: string) => fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer token', 'session-id': 'retry', 'content-type': 'application/json' }, body: JSON.stringify({ ...first, instructions, client_metadata: ++attempt % 2 ? { a: '1', b: '2' } : { b: '2', a: '1' }, input }) });
  const start = await events(await send(first.input));
  const call = start.at(-1).response.output[0];
  const repeatedCall = (await events(await send(first.input))).at(-1).response.output[0];
  assert.equal(repeatedCall.call_id, call.call_id, 'a lost tool response retains the original call ID');
  assert.equal(sessions[0].pending.size, 1);
  const input = [...first.input, call, { type: 'custom_tool_call_output', call_id: call.call_id, output: 'FILE_CONTENT' }];
  const disconnected = await send(input);
  const reader = disconnected.body!.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  const id = JSON.parse(initial.split('\n').find(l => l.startsWith('data: '))!.slice(6)).response.id;
  assert.equal((await send(input)).status, 409, 'an attached stream cannot have two consumers');
  await reader.cancel();
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await send(input, 'Changed retry')).status, 409, 'a changed retry cannot silently restart inference');
  const reconnect = await send(input);
  assert.equal(reconnect.status, 200);
  release();
  const recovered = await events(reconnect);
  assert.equal(recovered.at(-1).response.id, id);
  assert.equal(recovered.at(-1).response.output.filter((i: Item) => i.type?.endsWith('_call')).length, 0);
  assert.ok(recovered.some(e => e.type === 'response.output_text.delta' && e.delta === 'FILE_CONTENT'));
  assert.equal(fake.recorded.length, 1, 'reconnection must not start another model query');
  assert.equal(sessions[0].aborted, false);
  assert.equal(sessions[0].pending.size, 0);
  const replay = await events(await send(input));
  assert.deepEqual(replay, recovered, 'completed response retries replay existing events');
  assert.equal((await send(input)).status, 409, 'only two reconnections are allowed');
  assert.equal(fake.recorded.length, 1);
});

test('expired reconnections require a new message, including after adapter restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-reconnect-expiry-'));
  let release!: () => void;
  const quiet = new Promise<void>(r => { release = r; });
  const fake = fakeFactory();
  const factory: typeof query = args => {
    const q = fake.factory(args);
    const next = q.next.bind(q), close = q.close.bind(q);
    q.next = async (...args) => {
      const event = await next(...args);
      if (!event.done && event.value.type === 'stream_event') await quiet;
      return event;
    };
    q.close = () => { close(); release(); };
    return q;
  };
  const sessions: Session[] = [];
  const server = bridgeServer('token', dir, key => { const s = new Session(dir, key, factory); sessions.push(s); return s; });
  let outgoing!: import('node:http').ServerResponse;
  server.on('request', (_req, res) => { outgoing = res; });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { release(); server.close(); server.closeAllConnections(); await Promise.all(sessions.map(s => s.task)); t.mock.timers.reset(); await rm(dir, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const send = (input: unknown[]) => fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer token', 'session-id': 'expiry', 'content-type': 'application/json' }, body: JSON.stringify({ ...first, input }) });
  const start = await events(await send(first.input));
  const call = start.at(-1).response.output[0];
  const input = [...first.input, call, { type: 'custom_tool_call_output', call_id: call.call_id, output: 'FILE_CONTENT' }];
  const response = await send(input);
  const reader = response.body!.getReader();
  await reader.read();
  const disconnected = new Promise<void>(r => outgoing.once('close', r));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await reader.cancel(); await disconnected;
  t.mock.timers.tick(29_999);
  assert.equal(sessions[0].aborted, false);
  t.mock.timers.tick(1);
  await sessions[0].task;
  await new Promise(r => setImmediate(r));
  t.mock.timers.reset();
  assert.equal(sessions[0].aborted, true);
  assert.equal((await send(input)).status, 409);
  const restored = new Session(dir, 'expiry', fake.factory);
  await assert.rejects(restored.accept(requestSchema.parse({ ...first, input })), /new message/);
  assert.equal(fake.recorded.length, 1, 'expiration and restart must not replay inference');
  const recovery = fakeFactory(undefined, false);
  sessions[0].factory = recovery.factory;
  const continued = await events(await send([...input, { type: 'message', role: 'user', content: 'Continue using the completed result.' }]));
  assert.equal(continued.at(-1).response.output.filter((i: Item) => i.type?.endsWith('_call')).length, 0);
  assert.match(String(recovery.prompts[0]), /FILE_CONTENT/);
});

test('slow request admission still sends event heartbeats', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const dir = await mkdtemp(join(tmpdir(), 'codex-admission-'));
  let release!: () => void, enter!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const entered = new Promise<void>(r => { enter = r; });
  const fake = fakeFactory(undefined, false);
  const server = bridgeServer('token', dir, key => {
    const session = new Session(dir, key, fake.factory);
    const accept = session.accept.bind(session);
    session.accept = async (...args) => { enter(); await gate; await accept(...args); };
    return session;
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { release(); server.close(); server.closeAllConnections(); t.mock.timers.reset(); await rm(dir, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const pending = fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer token', 'session-id': 'admission', 'content-type': 'application/json' }, body: JSON.stringify(first) });
  await entered;
  t.mock.timers.tick(15_000);
  const response = await pending;
  const reader = response.body!.getReader();
  let initial = new TextDecoder().decode((await reader.read()).value);
  while (!initial.includes('event: response.in_progress')) initial += new TextDecoder().decode((await reader.read()).value);
  release();
  while (!(await reader.read()).done) {}
  assert.equal(fake.recorded.length, 1);
});


test('response replay buffering is bounded without truncating the live stream', () => {
  const response = new ResponseStream(new ServerResponse(new IncomingMessage(new Socket())), 'claude-fable-5-1');
  response.start();
  response.text('x'.repeat(4 * 1024 * 1024));
  assert.equal(response.replayable, false);
  assert.deepEqual(response.frames, []);
  assert.equal(response.output.length, 1);
  response.complete();
  assert.equal(response.ended, true);
  response.response.destroy();
});

test('steering a disconnected response preserves the live query and completed tool results', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-steer-live-'));
  let release!: () => void;
  const quiet = new Promise<void>(r => { release = r; });
  const fake = fakeFactory();
  let steeringProcessed = false;
  const factory: typeof query = args => {
    const q = fake.factory(args), next = q.next.bind(q), close = q.close.bind(q);
    let intermediate = false;
    q.next = async (...args) => {
      if (intermediate) { intermediate = false; return { done: false, value: { type: 'result', subtype: 'success', is_error: false, result: '', queued_turn_count: 0 } as SDKMessage }; }
      const event = await next(...args);
      if (!event.done && event.value.type === 'user' && event.value.message.content === 'Use that completed result and keep going.') steeringProcessed = true;
      if (!event.done && event.value.type === 'stream_event') { await quiet; intermediate = true; }
      return event;
    };
    q.close = () => { close(); release(); };
    return q;
  };
  const sessions: Session[] = [];
  const server = bridgeServer('token', dir, key => { const s = new Session(dir, key, factory); sessions.push(s); return s; });
  let outgoing!: ServerResponse;
  server.on('request', (_req, res) => { outgoing = res; });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { release(); server.close(); server.closeAllConnections(); await Promise.all(sessions.map(s => s.task)); await rm(dir, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const send = (input: unknown[]) => fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer token', 'session-id': 'steer' }, body: JSON.stringify({ ...first, input }) });
  const call = (await events(await send(first.input))).at(-1).response.output[0];
  const input = [...first.input, call, { type: 'custom_tool_call_output', call_id: call.call_id, output: 'FILE_CONTENT' }];
  const response = await send(input);
  const reader = response.body!.getReader(); await reader.read();
  const closed = new Promise<void>(r => outgoing.once('close', r));
  await reader.cancel(); await closed;
  const steered = await send([...input, { type: 'message', role: 'user', content: 'Use that completed result and keep going.' }]);
  release();
  const result = await events(steered);
  assert.equal(steeringProcessed, true, 'a zero queue count must not finish before the submitted steering message is processed');
  assert.equal(fake.recorded.length, 1, 'steering must not rebuild or resume another query');
  assert.equal(fake.prompts.at(-1), 'Use that completed result and keep going.');
  assert.equal(sessions[0].aborted, false);
  assert.equal(sessions[0].pending.size, 0);
  assert.equal(sessions[0].events.length, 0, 'the adapter must consume the steering replay and its final result');
  assert.equal(result.at(-1).type, 'response.completed');
  assert.equal(result.at(-1).response.output.filter((i: Item) => i.type?.endsWith('_call')).length, 0, 'completed action must not be dispatched again');
  assert.ok(result.some(e => e.type === 'response.output_text.delta' && e.delta === 'FILE_CONTENT'));
});

test('thinking streams as reasoning before text and survives response replay', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-thinking-'));
  const fake = fakeFactory(undefined, false);
  const factory: typeof query = args => {
    const q = fake.factory(args), next = q.next.bind(q);
    const thinking = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Checking the completed ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'private-signature' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'result.' } },
    ];
    q.next = async (...args) => thinking.length ? { done: false, value: { type: 'stream_event', event: thinking.shift() } as SDKMessage } : next(...args);
    return q;
  };
  const server = bridgeServer('token', dir, key => new Session(dir, key, factory));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.close(); server.closeAllConnections(); await rm(dir, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const send = () => fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer token', 'session-id': 'thinking' }, body: JSON.stringify(first) });
  const result = await events(await send());
  const deltas = result.filter(e => e.type === 'response.reasoning_summary_text.delta');
  assert.equal(deltas.map(e => e.delta).join(''), 'Checking the completed result.');
  const output = result.at(-1).response.output;
  assert.equal(output[0].type, 'reasoning');
  assert.equal(output[0].summary[0].text, 'Checking the completed result.');
  assert.equal(output[1].type, 'message');
  assert.ok(result.findIndex(e => e.type === 'response.reasoning_summary_text.done') < result.findIndex(e => e.type === 'response.output_text.delta'));
  assert.doesNotMatch(JSON.stringify(result), /private-signature/);
  assert.deepEqual(await events(await send()), result);
  assert.equal(fake.recorded.length, 1);
});


test('live steering requires unchanged instructions, model, history, and no unresolved actions', async () => {
  const session = new Session('/unused', 'steering-boundaries');
  session.running = true;
  session.state = { model: parsed.model, users: userMessages(parsed).map(digest), systemHash: digest(instructionsFor(parsed)), clean: false };
  const appended = requestSchema.parse({ ...first, input: [...first.input, { type: 'message', role: 'user', content: 'Keep going.' }] });
  assert.equal(session.canSteer(appended), true);
  assert.equal(session.canSteer(parsed), false, 'unchanged automatic retries are not steering');
  assert.equal(session.canSteer({ ...appended, instructions: 'Changed permissions' }), false);
  assert.equal(session.canSteer({ ...appended, model: 'claude-sonnet-5-5' }), false);
  assert.equal(session.canSteer(requestSchema.parse({ ...first, input: [{ type: 'message', role: 'user', content: 'Edited history' }, { type: 'message', role: 'user', content: 'Keep going.' }] })), false);
  session.pending.set('unresolved-call', () => {});
  assert.equal(session.canSteer(appended), false, 'a missing tool result cannot be assumed successful');
  session.pending.clear(); session.aborted = true;
  assert.equal(session.canSteer(appended), false);
  session.aborted = false;
  const reader = new AbortController();
  const oldWait = session.next(reader.signal);
  reader.abort();
  assert.equal(await oldWait, undefined);
  session.push({ type: 'text', text: 'Already generated' });
  assert.deepEqual(await session.next(), { type: 'text', text: 'Already generated' }, 'reader handoff must not drop subsequent SDK events');
  assert.equal(session.aborted, false, 'stopping an HTTP reader must not cancel the SDK');
});


test('completed turns reuse an idle query without repeating a tool and close after idle expiry', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] });
  const dir = await mkdtemp(join(tmpdir(), 'codex-warm-'));
  const fake = fakeFactory(undefined, true, undefined, true);
  const sessions: Session[] = [];
  const server = bridgeServer('token', dir, key => { const s = new Session(dir, key, fake.factory); sessions.push(s); return s; });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { for (const s of sessions) s.cancel(); server.close(); server.closeAllConnections(); await Promise.all(sessions.map(s => s.task)); t.mock.timers.reset(); await rm(dir, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const send = (input: unknown[]) => fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer token', 'session-id': 'warm' }, body: JSON.stringify({ ...first, input }) });
  const call = (await events(await send(first.input))).at(-1).response.output[0];
  const input = [...first.input, call, { type: 'custom_tool_call_output', call_id: call.call_id, output: 'FILE_CONTENT' }];
  await events(await send(input));
  assert.equal(sessions[0].running, true, 'the completed query must remain alive');
  assert.equal(sessions[0].state?.clean, true);
  assert.equal(sessions[0].pending.size, 0);
  const before = fake.prompts.length;
  t.mock.timers.tick(60_000);
  assert.equal(fake.prompts.length, before, 'idle time must not submit another prompt');
  const follow = await events(await send([...input, { type: 'message', role: 'user', content: 'Use the result already obtained.' }]));
  assert.equal(fake.recorded.length, 1);
  assert.equal(fake.prompts.at(-1), 'Use the result already obtained.');
  assert.equal(follow.at(-1).response.output.some((i: Item) => i.type?.endsWith('_call')), false);
  assert.ok(follow.some(e => e.delta === 'WARM_FOLLOW_UP'));
  t.mock.timers.tick(4 * 60_000 - 1);
  assert.equal(sessions[0].running, true);
  t.mock.timers.tick(1);
  await sessions[0].task;
  assert.equal(sessions[0].running, false);
  assert.equal(sessions[0].aborted, false, 'idle retirement preserves a clean resumable session');
  await events(await send([...input, { type: 'message', role: 'user', content: 'Use the result already obtained.' }, { type: 'message', role: 'user', content: 'Continue after expiry.' }]));
  assert.equal(fake.recorded.length, 2);
  assert.equal(fake.recorded[1].resume, 'fake-session');
});

test('only the three most recently completed queries stay idle and pending tools are not evicted', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-idle-cap-'));
  const fake = fakeFactory(undefined, true, undefined, true);
  const sessions: Session[] = [];
  const server = bridgeServer('token', dir, key => { const s = new Session(dir, key, fake.factory); sessions.push(s); return s; });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { for (const s of sessions) s.cancel(); server.close(); server.closeAllConnections(); await Promise.all(sessions.map(s => s.task)); await rm(dir, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const send = (key: string, input: unknown[]) => fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer token', 'session-id': key }, body: JSON.stringify({ ...first, input }) });
  await events(await send('pending', first.input));
  for (let i = 0; i < 4; i++) {
    const call = (await events(await send(`idle-${i}`, first.input))).at(-1).response.output[0];
    await events(await send(`idle-${i}`, [...first.input, call, { type: 'custom_tool_call_output', call_id: call.call_id, output: 'FILE_CONTENT' }]));
  }
  await sessions[1].task;
  assert.equal(sessions[1].running, false, 'the oldest idle query is retired');
  assert.equal(sessions[1].aborted, false);
  assert.equal(sessions[1].state?.clean, true);
  assert.equal(sessions.filter(s => s.running && s.idle).length, 3);
  assert.equal(sessions[0].running, true);
  assert.equal(sessions[0].pending.size, 1, 'a tool wait is active work, not an idle process');
  assert.equal(sessions[0].aborted, false);
});

test('idle configuration changes resume saved history with fresh instructions, tools and effort', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-idle-config-'));
  const fake = fakeFactory(undefined, false, undefined, true);
  const session = new Session(dir, 'config', fake.factory);
  t.after(async () => { session.cancel(); await session.task; await rm(dir, { recursive: true, force: true }); });
  let request = parsed;
  for (const change of [{}, { instructions: 'Use current permissions.' }, { tools: [{ type: 'function', name: 'checkpoint', parameters: { type: 'object', properties: {} } }] }, { reasoning: { effort: 'low' } }]) {
    request = requestSchema.parse({ ...request, ...change, input: [...request.input, { type: 'message', role: 'user', content: `Step ${fake.recorded.length}` }] });
    await session.accept(request);
    while ((await session.next()).type !== 'done') { /* Drain this completed turn. */ }
    session.inRequest = false;
    assert.equal(session.idle, true);
  }
  assert.equal(fake.recorded.length, 4);
  for (const options of fake.recorded.slice(1)) assert.equal(options.resume, 'fake-session');
  assert.deepEqual(fake.prompts.slice(1), ['Step 1', 'Step 2', 'Step 3'], 'saved sessions receive only new input, never completed tool history');
  assert.equal(fake.recorded[3].effort, 'low');
  assert.ok(Object.keys(fake.recorded[2].toolAliases!).includes('checkpoint'));
  assert.deepEqual(fake.recorded[1].systemPrompt, { type: 'custom', prompt: instructionsFor(request), snapshot: false });
});
