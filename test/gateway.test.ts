import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { forwardOpenAI, mixedCatalog, openaiModels, pinProvider, providerFor } from '../src/gateway.ts';
import { digest, requestSchema } from '../src/protocol.ts';

test('catalog exposes exactly the requested GPT models and retains Fast metadata', () => {
  const tiers = [{ id: 'priority', name: 'Fast' }, { id: 'ultrafast', name: 'Ultrafast' }];
  const native = { models: [...openaiModels, 'gpt-6-sol', 'gpt-5.6-luna'].map(slug => ({ slug, service_tiers: tiers, context_window: 272000, model_messages: { base: 'native prompt' } })) };
  const catalog = mixedCatalog({ models: [{ slug: 'claude-haiku-5-5' }, { slug: 'claude-fable-5-1' }] }, native);
  assert.deepEqual(catalog.models.filter(m => m.visibility === 'list').map(m => m.slug), openaiModels);
  for (const m of catalog.models.filter(m => openaiModels.includes(String(m.slug)))) {
    assert.deepEqual(m.service_tiers, tiers);
    assert.equal(m.context_window, 272000);
    assert.deepEqual(m.model_messages, { base: 'native prompt' });
  }
  assert.ok(!catalog.models.some(m => m.slug === 'gpt-6-sol'));
  for (const model of ['claude-haiku-5-5', 'claude-fable-5-1']) {
    assert.equal(providerFor(model), 'claude');
    assert.equal(requestSchema.parse({ model, input: [], stream: true }).model, model);
  }
  assert.throws(() => providerFor('unknown'), /Unsupported model/);
});

test('provider is locked across requests, context windows, restarts, and simultaneous first requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-pin-'));
  try {
    await pinProvider(dir, 'chat', 'openai');
    await pinProvider(dir, 'chat', 'openai');
    await assert.rejects(() => pinProvider(dir, 'chat', 'claude'), /Start a new chat/);
    const outcomes = await Promise.allSettled([pinProvider(dir, 'race', 'openai'), pinProvider(dir, 'race', 'claude')]);
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
    await mkdir(join(dir, 'sessions'));
    await writeFile(join(dir, 'sessions', `${digest('legacy')}.json`), '{}');
    await assert.rejects(() => pinProvider(dir, 'legacy', 'openai'), /This chat uses Claude/);
    await pinProvider(dir, 'legacy', 'claude');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('GPT forwarding preserves payload, Fast tier, auth, SSE and rate limits while stripping local credentials', async t => {
  const payload = { model: 'gpt-6.1-sol', service_tier: 'priority', input: [{ type: 'reasoning', encrypted_content: 'synthetic' }], stream: true };
  const wire = 'event: response.output_text.delta\ndata: {"delta":"OK"}\n\nevent: response.completed\ndata: {"response":{"status":"completed"}}\n\n';
  let called = false;
  const transport: typeof fetch = async (url, options) => {
    called = true;
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    const headers = new Headers(options?.headers);
    assert.equal(headers.get('authorization'), 'Bearer synthetic-chatgpt');
    assert.equal(headers.get('chatgpt-account-id'), 'synthetic-account');
    assert.equal(headers.get('x-codex-claude-key'), null);
    assert.equal(headers.get('cookie'), null);
    assert.equal(headers.get('x-openai-internal-codex-responses-lite'), 'true');
    assert.deepEqual(JSON.parse(String(options?.body)), payload);
    assert.equal(options?.redirect, 'error');
    return new Response(wire, { headers: { 'content-type': 'text/event-stream', 'x-codex-primary-used-percent': '5' } });
  };
  const server = createServer((req, res) => { void forwardOpenAI(req, res, payload, 'responses', transport).catch(error => { res.writeHead(500); res.end(String(error)); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const result = await fetch(`http://127.0.0.1:${address.port}`, { headers: { authorization: 'Bearer synthetic-chatgpt', 'chatgpt-account-id': 'synthetic-account', 'x-codex-claude-key': 'never-forward-me', cookie: 'local-cookie', 'x-openai-internal-codex-responses-lite': 'true' } });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('x-codex-primary-used-percent'), '5');
  assert.equal(await result.text(), wire);
  assert.ok(called);
});


test('setup preflight checks a fresh Mac login without modifying configuration', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adapter setup '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = join(dir, 'claude test');
  const config = 'model = "gpt-6-astra"\n';
  await writeFile(join(dir, 'config.toml'), config);
  const native = { models: openaiModels.map(slug => ({ slug })) };
  await writeFile(join(dir, 'models_cache.json'), JSON.stringify(native));
  const setAuth = (body: string) => writeFile(cli, `#!${process.execPath}\nif (process.env.ANTHROPIC_API_KEY) process.exit(9);\nif (process.argv.slice(2).join(' ') !== 'auth status --json') process.exit(8);\n${body}\n`, { mode: 0o700 });
  const run = (mode: string[] = ['check']) => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/setup.ts', import.meta.url)), ...mode], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, CODEX_HOME: dir, CODEX_CLAUDE_CLI: cli, ANTHROPIC_API_KEY: 'synthetic-ignored-key', CODEX_CLAUDE_PORT: '19382', CODEX_CLAUDE_STATE_DIR: fileURLToPath(new URL('../.local', import.meta.url)) },
  });
  await setAuth(`console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'}));`);
  const good = run();
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /No settings changed and no model request sent/);
  assert.equal(await readFile(join(dir, 'config.toml'), 'utf8'), config);
  assert.deepEqual((await readdir(dir)).sort(), ['claude test', 'config.toml', 'models_cache.json']);
  await setAuth(`console.log(JSON.stringify({loggedIn:true,authMethod:'api_key',apiProvider:'firstParty',subscriptionType:null,email:'private@example.test'}));`);
  const wrongLogin = run([]);
  assert.equal(wrongLogin.status, 1, 'default setup must refuse installation before changing settings');
  assert.match(wrongLogin.stderr, /subscription login is required/);
  assert.doesNotMatch(wrongLogin.stderr, /private@example/);
  await setAuth(`process.exit(1);`);
  assert.match(run().stderr, /claude auth login/);
  await setAuth(`console.log('private-invalid-status');`);
  const invalid = run();
  assert.match(invalid.stderr, /Could not read Claude login status/);
  assert.doesNotMatch(invalid.stderr, /private-invalid-status/);
  await rm(cli);
  assert.match(run().stderr, /Could not run Claude Code/);
  await writeFile(join(dir, 'models_cache.json'), JSON.stringify({ models: [] }));
  assert.match(run().stderr, /model cache is missing gpt-6.1-sol/, 'missing model handling stays unchanged');
  await rm(join(dir, 'config.toml'));
  assert.match(run().stderr, /Open Codex and sign in/);
});
