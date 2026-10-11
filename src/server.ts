import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { z, ZodError } from 'zod';
import { BridgeError, digest, jsonObject, requestFingerprint, requestSchema, ResponseStream, turnMetadata, userMessages } from './protocol.ts';
import { Session, toolTimeoutMs } from './session.ts';
import { forwardOpenAI, pinProvider, providerFor } from './gateway.ts';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const stateDir = resolve(process.env.CODEX_CLAUDE_STATE_DIR ?? join(root, '.local'));
const maxBody = 16 * 1024 * 1024;
type RecoverableResponse = { fingerprint: string; stream: ResponseStream; session: Session; retries: number; stopReading: AbortController; expiry?: NodeJS.Timeout; finished: Promise<void>; finish: () => void };

export async function localToken(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'token');
  try { await writeFile(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return (await readFile(path, 'utf8')).trim();
}

export function authorized(header: string | undefined, token: string): boolean {
  const actual = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readRequest(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBody) throw new BridgeError('Request exceeds the 16 MiB limit.', 413);
    chunks.push(chunk);
  }
  let body = Buffer.concat(chunks);
  const encoding = req.headers['content-encoding'];
  if (encoding === 'zstd') body = zstdDecompressSync(body, { maxOutputLength: maxBody });
  else if (encoding && encoding !== 'identity') throw new BridgeError('Unsupported content encoding.', 415);
  try { return jsonObject.parse(JSON.parse(body.toString('utf8'))); }
  catch (error) {
    if (error instanceof ZodError) throw new BridgeError(error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    throw new BridgeError('Invalid JSON request.');
  }
}

function sendError(res: ServerResponse, error: unknown) {
  const known = error instanceof BridgeError;
  res.writeHead(known ? error.status : 500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { type: known ? error.code : 'bridge_error', message: known ? error.message : 'The adapter encountered an internal error. See its local log.' } }));
  if (!known) console.error(error instanceof Error ? error.message : String(error));
}

export function bridgeServer(token: string, directory: string, sessionFactory = (key: string) => new Session(join(directory, 'sessions'), key)) {
  const sessions = new Map<string, Session>();
  const responses = new Map<string, RecoverableResponse>();
  function trimIdle() {
    const idle = [...sessions.values()].filter(s => s.running && s.idle && !s.inRequest && !s.retiring).sort((a, b) => b.touched - a.touched);
    for (const session of idle.slice(3)) session.closeIdle();
  }
  function retain(key: string, response: RecoverableResponse) {
    if (responses.get(key) !== response) return;
    clearTimeout(response.expiry);
    response.expiry = setTimeout(() => {
      if (responses.get(key) !== response) return;
      responses.delete(key);
      if (!response.stream.ended) response.session.cancel();
    }, 30_000).unref();
  }
  function attach(key: string, response: RecoverableResponse, res: ServerResponse) {
    clearTimeout(response.expiry);
    response.stream.attach(res);
    res.on('close', () => {
      if (response.stream.response === res && !response.stream.ended) retain(key, response);
    });
    if (response.stream.ended) retain(key, response);
  }
  const server = createServer(async (req, res) => {
    const gateway = req.url?.startsWith('/gateway/') ?? false;
    const credential = gateway && typeof req.headers['x-codex-claude-key'] === 'string' ? `Bearer ${req.headers['x-codex-claude-key']}` : req.headers.authorization;
    if (req.headers.origin || !authorized(credential, token)) return sendError(res, new BridgeError('A local adapter credential is required.', 401, 'unauthorized'));
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'codex-claude', pid: process.pid, sessions: sessions.size })); return;
    }
    let session: Session | undefined;
    let stream: ResponseStream | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let transientKey: string | undefined;
    let recovery: RecoverableResponse | undefined;
    let responseKey: string | undefined;
    try {
      if (gateway && req.method === 'GET' && req.url?.split('?')[0] === '/gateway/models') {
        const catalog = await readFile(join(directory, 'mixed-models.json'));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(catalog); return;
      }
      const endpoint = gateway ? req.url!.slice('/gateway/'.length) : req.url === '/v1/responses' ? 'responses' : '';
      if (req.method !== 'POST' || !['responses', 'responses/compact', 'responses/lite'].includes(endpoint)) throw new BridgeError('Unsupported endpoint.', 404);
      const body = await readRequest(req);
      const routing = z.object({ model: z.string(), client_metadata: z.record(z.string(), z.string()).optional(), prompt_cache_key: z.string().optional() }).parse(body);
      const metadata = turnMetadata(routing, req.headers['x-codex-turn-metadata']);
      const conversation = metadata.thread_id ?? req.headers['session-id'] ?? routing.client_metadata?.session_id ?? routing.prompt_cache_key;
      if (typeof conversation !== 'string' || !conversation || conversation.length > 256) throw new BridgeError('A stable session-id is required.');
      const provider = providerFor(routing.model);
      if (provider === 'openai') {
        if (!gateway || authorized(req.headers.authorization, token)) throw new BridgeError('Use the mixed gateway configuration with ChatGPT sign-in for Codex models.', 401);
        await pinProvider(directory, conversation, provider);
        await forwardOpenAI(req, res, body, endpoint); return;
      }
      if (endpoint !== 'responses') throw new BridgeError('This endpoint is only supported for Codex/OpenAI models.', 400);
      const request = requestSchema.parse(body);
      await pinProvider(directory, conversation, provider);
      const window = metadata.window_number;
      const compact = metadata.request_kind === 'compaction';
      const key = compact ? `${conversation}:compact:${randomUUID()}` : window ? `${conversation}:window:${window}` : conversation;
      if (compact) {
        transientKey = key;
        request.tools = [];
        request.input = request.input.filter(i => i.type !== 'additional_tools');
      }
      const fingerprint = requestFingerprint(request);
      const cacheKey = compact ? `${conversation}:compact:${fingerprint}` : key;
      const previous = responses.get(cacheKey);
      if (previous) {
        if (!previous.stream.ended && !previous.stream.response.destroyed) throw new BridgeError('Another request is active for this conversation.', 409, 'conversation_busy');
        if (previous.fingerprint === fingerprint) {
          if (!previous.stream.replayable || previous.retries >= 2) throw new BridgeError('Response reconnection limit reached. Send a new message to continue from recorded tool results.', 409, 'session_interrupted');
          previous.retries++;
          attach(cacheKey, previous, res);
          return;
        }
        if (!previous.stream.ended) {
          if (digest(userMessages(request).map(digest)) === digest(previous.session.state?.users)) throw new BridgeError('The disconnected request changed. Send a new message to continue from recorded tool results.', 409, 'session_interrupted');
          if (previous.session.canSteer(request)) previous.stopReading.abort();
          else previous.session.cancel();
          await previous.finished;
        }
        clearTimeout(previous.expiry);
        if (responses.get(cacheKey) === previous) responses.delete(cacheKey);
      }
      session = sessions.get(key);
      if (!session) {
        if (sessions.size >= 32) throw new BridgeError('Too many live conversations. Restart the adapter after active turns finish.', 503);
        session = sessionFactory(key); sessions.set(key, session);
      }
      if (session.inRequest) throw new BridgeError('Another request is active for this conversation.', 409, 'conversation_busy');
      stream = new ResponseStream(res, request.model);
      let finish!: () => void;
      const finished = new Promise<void>(resolve => { finish = resolve; });
      recovery = { fingerprint, stream, session, retries: 0, stopReading: new AbortController(), finished, finish };
      responseKey = cacheKey;
      for (const [oldKey, old] of responses) {
        if (responses.size < 32) break;
        if (old.stream.ended) { clearTimeout(old.expiry); responses.delete(oldKey); }
      }
      responses.set(cacheKey, recovery);
      attach(cacheKey, recovery, res);
      heartbeat = setInterval(() => stream!.heartbeat(), 15_000);
      await session.accept(request, compact || Number(window) > 0 || [metadata.parent_thread_id, metadata.forked_from_thread_id].some(id => id && id !== conversation));
      stream.start();
      while (!stream.ended) {
        const event = await session.next(recovery.stopReading.signal);
        if (!event) break;
        if (recovery.stopReading.signal.aborted) { session.events.unshift(event); break; }
        if (event.type === 'thinking') stream.thinking(event.text);
        if (event.type === 'turn_boundary') { stream.finishThinking(); stream.finishText('commentary'); }
        if (event.type === 'text') stream.text(event.text);
        if (event.type === 'tool') { stream.tool(event.tool, event.args, event.callId); stream.complete(session.usage); }
        if (event.type === 'done') stream.complete(event.usage);
        if (event.type === 'error') stream.fail(event.error);
      }
    } catch (error) {
      if (stream?.started) stream.fail(error instanceof Error ? error : new Error(String(error)));
      else if (error instanceof ZodError) sendError(stream?.response ?? res, new BridgeError(error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')));
      else sendError(stream?.response ?? res, error);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (session && stream) session.inRequest = false;
      if (recovery && responseKey) {
        recovery.finish();
        if (stream?.ended) retain(responseKey, recovery);
        else { clearTimeout(recovery.expiry); responses.delete(responseKey); }
      }
      if (transientKey) { session?.cancel(); sessions.delete(transientKey); }
      trimIdle();
    }
  });
  const expiry = setInterval(() => {
    for (const [key, session] of sessions) {
      const timeout = session.running && !session.aborted && session.pending.size > 0 ? toolTimeoutMs : 600_000;
      if (Date.now() - session.touched < timeout || session.inRequest) continue;
      if (session.running) session.cancel();
      sessions.delete(key);
    }
  }, 60_000).unref();
  server.on('close', () => { clearInterval(expiry); for (const r of responses.values()) clearTimeout(r.expiry); for (const s of sessions.values()) s.cancel(); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const token = await localToken(stateDir);
  const port = Number(process.env.CODEX_CLAUDE_PORT ?? 19382);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('CODEX_CLAUDE_PORT must be a port between 1024 and 65535.');
  const server = bridgeServer(token, stateDir);
  server.listen(port, '127.0.0.1', () => console.log(`codex-claude listening at http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
}
