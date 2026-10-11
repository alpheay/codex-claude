import { mkdir, readFile, writeFile, link, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { BridgeError, digest } from './protocol.ts';

export const openaiModels = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'];
const internalModels = ['gpt-5.6-luna', 'codex-auto-review'];
export const claudeModels = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
export function providerFor(model: string) {
  if (claudeModels.includes(model)) return 'claude';
  if ([...openaiModels, ...internalModels].includes(model)) return 'openai';
  throw new BridgeError(`Unsupported model: ${model}`);
}

export function mixedCatalog(claude: { models: Record<string, unknown>[] }, native: { models: Record<string, unknown>[] }): { models: Record<string, unknown>[] } {
  const wanted = [...openaiModels, ...internalModels];
  const models = wanted.flatMap(slug => {
    const model = native.models.find(m => m.slug === slug);
    if (!model && openaiModels.includes(slug)) throw new Error(`Codex's model cache is missing ${slug}. Refresh it using the native OpenAI provider first.`);
    return model ? [{ ...model, visibility: openaiModels.includes(slug) ? 'list' : 'hide', priority: wanted.indexOf(slug) + 1 }] : [];
  });
  return { models: [...models, ...claude.models.map((m, i) => ({ ...m, priority: 10 + i }))] };
}

export async function pinProvider(directory: string, conversation: string, provider: 'claude' | 'openai') {
  const routeDir = join(directory, 'routes');
  await mkdir(routeDir, { recursive: true, mode: 0o700 });
  const path = join(routeDir, `${digest(conversation)}.json`);
  let original = provider;
  try {
    await readFile(join(directory, 'sessions', `${digest(conversation)}.json`));
    original = 'claude';
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ provider: original }), { mode: 0o600 });
  try { await link(temp, path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  finally { await rm(temp, { force: true }); }
  const saved = z.object({ provider: z.enum(['claude', 'openai']) }).parse(JSON.parse(await readFile(path, 'utf8')));
  if (saved.provider !== provider) throw new BridgeError(`This chat uses ${saved.provider === 'claude' ? 'Claude' : 'Codex/OpenAI'}. Start a new chat to change providers, or select its original provider again.`, 409, 'provider_locked');
}

export async function forwardOpenAI(req: IncomingMessage, res: ServerResponse, body: unknown, endpoint: string, transport = fetch) {
  if (!req.headers.authorization?.startsWith('Bearer ')) throw new BridgeError('ChatGPT sign-in is required for Codex models.', 401);
  const headers = new Headers();
  const stripped = new Set(['host', 'connection', 'content-length', 'content-encoding', 'transfer-encoding', 'cookie', 'x-codex-claude-key']);
  for (const [name, value] of Object.entries(req.headers)) {
    if (value && !stripped.has(name)) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set('content-type', 'application/json');
  headers.set('accept-encoding', 'identity');
  const abort = new AbortController();
  const disconnect = () => { if (!res.writableFinished) abort.abort(); };
  res.on('close', disconnect);
  try {
    const upstream = await transport(`https://chatgpt.com/backend-api/codex/${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body), signal: abort.signal, redirect: 'error' });
    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'].includes(name)) responseHeaders[name] = value;
    });
    res.writeHead(upstream.status, responseHeaders);
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
    else res.end();
  } catch (error) {
    if (res.headersSent || abort.signal.aborted) res.destroy();
    else throw new BridgeError('The connection to OpenAI failed. Your request was not automatically retried.', 502, 'upstream_connection_failed');
  } finally { res.off('close', disconnect); }
}
