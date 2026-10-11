import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { query, type SDKMessage, type SDKUserMessage, type Query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Ajv } from 'ajv';
import { z } from 'zod';
import { BridgeError, digest, emptyUsage, historyContent, instructionsFor, joinContent, jsonObject, textContent, toolResult, toolsFor, userMessages, type ModelContent, type JsonObject, type Request, type Tool, type Usage } from './protocol.ts';

type Event = { type: 'text' | 'thinking'; text: string } | { type: 'tool'; tool: Tool; args: JsonObject; callId: string } | { type: 'turn_boundary' } | { type: 'done'; usage: Usage } | { type: 'error'; error: Error };
const snapshotSchema = z.object({ sessionId: z.string().optional(), model: z.string(), users: z.array(z.string()), systemHash: z.string(), clean: z.boolean() });
type Snapshot = z.infer<typeof snapshotSchema>;
export const toolTimeoutMs = 24 * 60 * 60 * 1000;

export function subscriptionEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_USE_') || ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_1M_CONTEXT'].includes(key)) delete env[key];
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'codex-claude/0.1.0';
  return env;
}

export class Session {
  stateDir: string;
  file: string;
  state?: Snapshot;
  query?: Query;
  running = false;
  retiring = false;
  idle = false;
  idleTimer?: NodeJS.Timeout;
  configurationHash?: string;
  inRequest = false;
  aborted = false;
  touched = Date.now();
  pending = new Map<string, (result: CallToolResult) => void>();
  events: Event[] = [];
  waiter?: (event: Event) => void;
  usage = emptyUsage();
  rawUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  task?: Promise<void>;
  sendInput?: (text: ModelContent) => Promise<void>;
  factory: typeof query;
  constructor(stateDir: string, key: string, factory = query) {
    this.stateDir = stateDir; this.file = join(stateDir, `${digest(key)}.json`); this.factory = factory;
  }
  push(event: Event) {
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(event); }
    else this.events.push(event);
  }
  next(): Promise<Event>;
  next(signal: AbortSignal): Promise<Event | undefined>;
  next(signal?: AbortSignal): Promise<Event | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    const event = this.events.shift();
    if (event) return Promise.resolve(event);
    return new Promise(resolve => {
      const deliver = (event: Event) => { signal?.removeEventListener('abort', stop); resolve(event); };
      const stop = () => { if (this.waiter === deliver) this.waiter = undefined; resolve(undefined); };
      this.waiter = deliver;
      signal?.addEventListener('abort', stop, { once: true });
    });
  }
  canSteer(request: Request): boolean {
    if (!this.running || this.aborted || this.idle || this.pending.size || !this.state || this.state.model !== request.model) return false;
    const users = userMessages(request).map(digest);
    return users.length > this.state.users.length && this.state.users.every((value, index) => users[index] === value)
      && this.state.systemHash === digest(instructionsFor(request));
  }
  closeIdle() {
    if (!this.running || !this.idle || this.pending.size) return;
    this.retiring = true;
    clearTimeout(this.idleTimer);
    this.query?.close();
  }
  async load() {
    if (this.state) return;
    try { this.state = snapshotSchema.parse(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async save() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.tmp`;
    await writeFile(temp, JSON.stringify(this.state), { mode: 0o600 });
    await rename(temp, this.file);
  }
  async accept(request: Request, importHistory = false) {
    if (this.inRequest) throw new BridgeError('Another request is active for this conversation.', 409, 'conversation_busy');
    this.inRequest = true;
    try {
      await this.load();
      if (!this.running || this.aborted || this.retiring) await this.task;
      this.touched = Date.now();
      const messages = userMessages(request);
      const users = messages.map(digest);
      const system = instructionsFor(request);
      const systemHash = digest(system);
      const configurationHash = digest({ model: request.model, effort: request.reasoning?.effort ?? 'medium', systemHash, tools: toolsFor(request) });
      if (this.running && this.idle && this.configurationHash !== configurationHash) {
        this.closeIdle();
        await this.task;
      }
      const historyChanged = this.state?.users.some((value, index) => users[index] !== value);
      const interrupted = this.aborted || (this.state && !this.state.clean && !this.running);
      if (interrupted && this.state && !historyChanged && users.length === this.state.users.length) throw new BridgeError('The disconnected response can no longer be resumed safely. Send a new message to continue from recorded tool results.', 409, 'session_interrupted');
      const instructionsChanged = this.running && !this.state?.clean && this.state?.systemHash !== systemHash;
      const hasPendingResult = request.input.some(i => ['function_call_output', 'custom_tool_call_output'].includes(i.type ?? '') && typeof i.call_id === 'string' && this.pending.has(i.call_id));
      const continuedAfterStop = this.running && this.pending.size > 0 && !hasPendingResult && users.length > (this.state?.users.length ?? 0);
      if (interrupted || historyChanged || instructionsChanged || continuedAfterStop) {
        this.cancel();
        await this.task;
        this.events = [];
        this.aborted = false;
        this.state = undefined;
        importHistory = true;
      }
      if (this.running) {
        // shortcut: tools stay fixed during a turn; refresh MCP if mid-turn connections become necessary.
        const results = new Map<string, CallToolResult>();
        for (const item of request.input) {
          if (!['function_call_output', 'custom_tool_call_output'].includes(item.type ?? '')) continue;
          const callId = z.string().parse(item.call_id);
          const resolve = this.pending.get(callId);
          if (!resolve) continue;
          results.set(callId, toolResult(item.output));
        }
        const added = messages.slice(this.state!.users.length);
        if (!results.size && this.events.length === 0 && !added.length) throw new BridgeError('Expected the result of the outstanding Codex tool call.', 409);
        if (this.state!.model !== request.model) {
          await this.query!.setModel(request.model);
          this.state!.model = request.model;
          await this.save();
        }
        if (added.length) {
          this.state!.users = users;
          this.state!.clean = false;
          this.idle = false;
          clearTimeout(this.idleTimer);
          await this.save();
          await this.sendInput!(joinContent(added));
        }
        for (const [callId, result] of results) {
          const resolve = this.pending.get(callId)!;
          this.pending.delete(callId);
          resolve(result);
        }
        return;
      }
      const newMessages = messages.slice(this.state?.users.length ?? 0);
      if (!newMessages.length) throw new BridgeError('No new user message. A completed request cannot be replayed.', 409);
      if (!this.state && !importHistory && request.input.some(i => ['function_call', 'custom_tool_call'].includes(i.type ?? '') || i.role === 'assistant')) {
        throw new BridgeError('Start a fresh Claude chat. Importing another provider’s history is not supported.', 409);
      }
      const resume = this.state?.sessionId;
      const text = !resume && importHistory ? historyContent(request.input) : joinContent(newMessages);
      this.state = { model: request.model, users, systemHash, sessionId: resume, clean: false };
      await this.save();
      this.configurationHash = configurationHash;
      this.running = true;
      this.task = this.run(request, system, text, resume);
    } catch (error) { this.inRequest = false; throw error; }
  }
  async run(request: Request, system: string, text: ModelContent, resume?: string) {
    const session = this;
    const submitted = new Set<string>();
    let allowInput!: () => void;
    const ready = new Promise<void>(resolve => { allowInput = resolve; });
    type Delivery = { text: ModelContent; resolve: () => void; reject: (error: Error) => void };
    let receive!: (delivery: Delivery | undefined) => void;
    const inbox = () => new Promise<Delivery | undefined>(resolve => { receive = resolve; });
    let nextInput = inbox();
    let pendingInput: Delivery | undefined;
    this.sendInput = text => new Promise<void>((resolve, reject) => { pendingInput = { text, resolve, reject }; receive(pendingInput); });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      await ready;
      if (session.aborted) return;
      yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, client_composed: true, uuid: randomUUID() };
      while (true) {
        const delivery = await nextInput;
        if (!delivery) return;
        nextInput = inbox();
        const uuid = randomUUID();
        submitted.add(uuid);
        yield { type: 'user', message: { role: 'user', content: delivery.text }, parent_tool_use_id: null, client_composed: true, uuid, priority: 'next' };
        delivery.resolve(); pendingInput = undefined;
      }
    }
    try {
      const tools = toolsFor(request);
      const mcp = this.createTools(tools);
      const aliases = Object.fromEntries(tools.map(t => [t.namespace ? `${t.namespace}.${t.name}` : t.name, `mcp__codex__${t.key}`]));
      const workDir = join(this.stateDir, 'runtime');
      await mkdir(workDir, { recursive: true, mode: 0o700 });
      const options: Options = {
        model: request.model, effort: request.reasoning?.effort ?? 'medium', resume,
        cwd: workDir, pathToClaudeCodeExecutable: process.env.CODEX_CLAUDE_CLI ?? '/opt/homebrew/bin/claude',
        tools: [], toolAliases: aliases, settingSources: [], strictMcpConfig: true,
        // Codex can update permissions between turns; the SDK reconciles thinking on prompt changes.
        systemPrompt: { type: 'custom', prompt: system, snapshot: false }, includePartialMessages: true, env: subscriptionEnvironment(),
        mcpServers: { codex: { type: 'sdk', name: 'codex', instance: mcp, timeout: toolTimeoutMs } },
        allowedTools: tools.map(t => `mcp__codex__${t.key}`), permissionMode: 'dontAsk',
        settings: { disableAllHooks: true }, extraArgs: { 'disable-slash-commands': null, 'replay-user-messages': null },
      };
      this.query = this.factory({ prompt: input(), options });
      const account = await this.query.accountInfo();
      if (account.apiProvider !== 'firstParty' || !account.subscriptionType || (account.apiKeySource && account.apiKeySource !== 'none')) {
        throw new BridgeError('Claude subscription authentication is required. Run claude auth login; API credentials are not accepted.', 401, 'subscription_required');
      }
      allowInput();
      for await (const message of this.query) {
        if (this.aborted || this.retiring) break;
        if (message.type === 'user' && 'isReplay' in message && message.isReplay && message.uuid) submitted.delete(message.uuid);
        this.consume(message);
        if (message.type === 'result') {
          if (message.is_error || message.subtype !== 'success') {
            throw new BridgeError(message.subtype === 'success' ? message.result : message.errors.join('\n'), 502, 'claude_error');
          }
          // Client-composed steering can be absent from the CLI's queued-turn count.
          if (submitted.size || message.queued_turn_count) { this.push({ type: 'turn_boundary' }); continue; }
          this.state!.clean = true;
          await this.save();
          this.idle = true;
          clearTimeout(this.idleTimer);
          this.idleTimer = setTimeout(() => this.closeIdle(), 4 * 60_000).unref();
          this.touched = Date.now();
          this.push({ type: 'done', usage: this.usage });
        }
      }
      if (this.running && !this.aborted && !this.retiring && !this.idle) throw new BridgeError('Claude ended without a completion event.', 502);
    } catch (error) {
      if (!this.retiring && !this.idle) {
        this.aborted = true;
        this.push({ type: 'error', error: error instanceof Error ? error : new Error(String(error)) });
      }
    } finally {
      this.running = false;
      this.retiring = false;
      this.idle = false;
      clearTimeout(this.idleTimer);
      allowInput(); receive(undefined);
      pendingInput?.reject(new BridgeError('Claude stopped before accepting the new message.', 409, 'session_interrupted'));
      this.sendInput = undefined;
      this.query?.close(); this.query = undefined;
      for (const resolve of this.pending.values()) resolve({ isError: true, content: [{ type: 'text', text: 'Codex cancelled this turn.' }] });
      this.pending.clear();
    }
  }
  createTools(tools: Tool[]): McpServer {
    const mcp = new McpServer({ name: 'codex', version: '0.1.0' }, { capabilities: { tools: { listChanged: false } } });
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const validators = new Map(tools.map(tool => [tool.key, ajv.compile(tool.schema)]));
    mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(tool => ({ name: tool.key, description: tool.description, inputSchema: tool.schema, _meta: { 'anthropic/alwaysLoad': true } })) }));
    mcp.server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const tool = tools.find(t => t.key === params.name);
      const args = jsonObject.parse(params.arguments ?? {});
      if (!tool || !validators.get(tool.key)!(args)) return { isError: true, content: [{ type: 'text', text: 'Unknown tool or invalid arguments.' }] };
      if (this.aborted || this.retiring || this.state?.clean) return { isError: true, content: [{ type: 'text', text: 'The Codex turn was cancelled.' }] };
      const callId = `call_${randomUUID()}`;
      return await new Promise<CallToolResult>(resolve => {
        this.touched = Date.now();
        this.pending.set(callId, resolve);
        this.push({ type: 'tool', tool, args, callId });
      });
    });
    return mcp;
  }
  consume(message: SDKMessage) {
    if (message.type === 'system' && message.subtype === 'init') this.state!.sessionId = message.session_id;
    if (message.type === 'rate_limit_event') {
      const info = message.rate_limit_info;
      if (info.isUsingOverage || info.overageInUse || info.status === 'rejected') throw new BridgeError('Claude subscription allowance is exhausted or extra usage is active. The bridge has stopped.', 429, 'subscription_limit');
    }
    if (message.type === 'assistant' && message.error) throw new BridgeError(textContent(message.message.content), 502, message.error);
    if (message.type === 'assistant' && message.message.model !== this.state?.model) throw new BridgeError(`Claude returned a different model: ${message.message.model}. Automatic model fallback is not supported.`, 502, 'model_mismatch');
    if (message.type === 'stream_event') {
      const event = message.event;
      if (event.type === 'content_block_start' && event.content_block.type === 'thinking') this.push({ type: 'thinking', text: event.content_block.thinking });
      if (event.type === 'content_block_start' && event.content_block.type === 'redacted_thinking') this.push({ type: 'thinking', text: 'Thinking…' });
      if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') this.push({ type: 'thinking', text: event.delta.thinking });
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') this.push({ type: 'text', text: event.delta.text });
      if (event.type === 'message_start') {
        this.rawUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        this.updateUsage(event.message.usage);
      }
      if (event.type === 'message_delta') this.updateUsage(event.usage);
    }
  }
  updateUsage(update: Partial<Record<keyof Session['rawUsage'], number | null>>) {
    for (const key of Object.keys(this.rawUsage) as (keyof Session['rawUsage'])[]) {
      const value = update[key];
      if (typeof value === 'number') this.rawUsage[key] = value;
    }
    const u = this.rawUsage;
    this.usage = { input_tokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, output_tokens: u.output_tokens, cached_tokens: u.cache_read_input_tokens };
  }
  cancel() {
    if (this.aborted) return;
    this.aborted = true; clearTimeout(this.idleTimer); this.query?.close();
    this.push({ type: 'error', error: new BridgeError('The Claude turn was interrupted.', 409, 'session_interrupted') });
  }
}
