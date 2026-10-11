import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ServerResponse } from 'node:http';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const jsonObject = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof jsonObject>;
export const itemSchema = jsonObject.and(z.object({ type: z.string().optional(), role: z.string().optional() }));
export type Item = z.infer<typeof itemSchema>;
export const requestSchema = z.object({
  model: z.enum(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']),
  input: z.array(itemSchema),
  instructions: z.string().optional(),
  tools: z.array(jsonObject).default([]),
  stream: z.literal(true),
  reasoning: z.object({ effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional() }).passthrough().optional(),
  tool_choice: z.literal('auto').optional(),
  client_metadata: z.record(z.string(), z.string()).optional(),
  prompt_cache_key: z.string().optional(),
  previous_response_id: z.string().optional(),
}).passthrough();
export type Request = z.infer<typeof requestSchema>;

export function turnMetadata(request: Pick<Request, 'client_metadata'>, header?: string | string[]) {
  const raw = header ?? request.client_metadata?.['x-codex-turn-metadata'];
  try {
    if (raw !== undefined && typeof raw !== 'string') throw new Error('Multiple metadata headers');
    return z.object({ window_number: z.number().int().min(0).max(100_000_000).default(0), request_kind: z.string().optional(), thread_id: z.string().min(1).max(256).optional(), parent_thread_id: z.string().min(1).max(256).optional(), forked_from_thread_id: z.string().min(1).max(256).optional() }).parse(raw === undefined ? {} : JSON.parse(raw));
  } catch { throw new BridgeError('Invalid Codex turn metadata.'); }
}

export class BridgeError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'invalid_request_error') {
    super(message); this.status = status; this.code = code;
  }
}

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function requestFingerprint(request: Request): string {
  const serialized = JSON.stringify(request, (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  return createHash('sha256').update(serialized).digest('hex');
}

export function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new BridgeError('Expected text content.');
  return content.map(part => {
    const p = jsonObject.parse(part);
    if (!['input_text', 'output_text', 'text'].includes(String(p.type)) || typeof p.text !== 'string') {
      throw new BridgeError(`Expected text content, received ${String(p.type)}.`);
    }
    return p.text;
  }).join('\n');
}

type ContentBlock = Extract<Exclude<SDKUserMessage['message']['content'], string>[number], { type: 'text' | 'image' }>;
export type ModelContent = string | ContentBlock[];

export function modelContent(content: unknown): ModelContent {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new BridgeError('Expected message content.');
  const blocks = content.map((part): ContentBlock => {
    const p = jsonObject.parse(part);
    if (['text', 'input_text', 'output_text'].includes(String(p.type)) && typeof p.text === 'string') return { type: 'text', text: p.text };
    const url = p.type === 'input_image' ? p.image_url : p.type === 'image' ? `data:${p.mimeType};base64,${p.data}` : undefined;
    if (typeof url !== 'string') throw new BridgeError(`Unsupported content type: ${String(p.type)}.`);
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
    if (!match || Buffer.from(match[2], 'base64').toString('base64') !== match[2]) throw new BridgeError('Images must be embedded PNG, JPEG, GIF, or WebP base64 data.');
    const media_type = z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']).parse(match[1]);
    return { type: 'image', source: { type: 'base64', media_type, data: match[2] } };
  });
  return blocks.every(b => b.type === 'text') ? textContent(content) : blocks;
}

export function joinContent(messages: ModelContent[]): ModelContent {
  if (messages.every(m => typeof m === 'string')) return messages.join('\n\n');
  return messages.flatMap(m => typeof m === 'string' ? [{ type: 'text' as const, text: m }] : m);
}

export function toolResult(content: unknown): CallToolResult {
  const blocks = modelContent(content);
  if (typeof blocks === 'string') return { content: [{ type: 'text', text: blocks }] };
  return { content: blocks.map(block => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.source.type !== 'base64') throw new BridgeError('Tool images must be embedded.');
    return { type: 'image', mimeType: block.source.media_type, data: block.source.data };
  }) };
}

export function historyContent(input: Item[]): ModelContent {
  const images: ContentBlock[] = [];
  const history = input.filter(i => !['system', 'developer'].includes(i.role ?? '') && !['reasoning', 'additional_tools'].includes(i.type ?? '')).map(item => {
    const key = item.type?.endsWith('_output') ? 'output' : 'content';
    if (!(key in item)) return item;
    const content = modelContent(item[key]);
    if (typeof content === 'string') return item;
    return { ...item, [key]: content.map(block => {
      if (block.type === 'text') return block;
      images.push(block);
      return { type: 'text', text: `[Image ${images.length} attached below]` };
    }) };
  });
  const text = `Continue this conversation supplied by Codex. The JSON below is recorded history, including completed actions and their results. Respond to its latest user request using those results; do not repeat completed actions. A tool call without a recorded result has an unknown outcome; check its outcome before attempting that action again.\n${JSON.stringify(history)}`;
  return images.length ? [{ type: 'text', text }, ...images] : text;
}

export type Tool = {
  key: string;
  name: string;
  namespace?: string;
  kind: 'function' | 'custom';
  description: string;
  schema: JsonObject & { type: 'object' };
};

export function toolsFor(request: Request): Tool[] {
  const tools = new Map<string, Tool>();
  function visit(raw: JsonObject, namespace?: string) {
    // Codex can advertise hosted search globally; only the OpenAI route can execute it.
    if (raw.type === 'web_search' || raw.type === 'web_search_preview') return;
    if (raw.type === 'namespace') {
      const ns = z.string().parse(raw.name);
      for (const child of z.array(jsonObject).parse(raw.tools)) visit(child, namespace ? `${namespace}.${ns}` : ns);
      return;
    }
    if (raw.type !== 'custom' && raw.type !== 'function') throw new BridgeError(`Unsupported tool type: ${String(raw.type)}`);
    const name = z.string().parse(raw.name);
    const identity = namespace ? `${namespace}.${name}` : name;
    const key = `${identity.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0,40)}_${digest(identity).slice(0,8)}`;
    let description = typeof raw.description === 'string' ? raw.description : '';
    let schema: Tool['schema'];
    if (raw.type === 'function') {
      schema = jsonObject.and(z.object({ type: z.literal('object') })).parse(raw.parameters);
    } else {
      if (raw.format) description += `\nInput format constraint: ${JSON.stringify(raw.format)}`;
      schema = { type: 'object', properties: { input: { type: 'string', description: 'The complete raw tool input, without JSON wrapping or Markdown fences inside this string.' } }, required: ['input'], additionalProperties: false };
    }
    tools.set(identity, { key, name, namespace, kind: raw.type, description, schema });
  }
  for (const t of request.tools) visit(t);
  for (const item of request.input) {
    if (item.type === 'additional_tools') for (const t of z.array(jsonObject).parse(item.tools)) visit(t);
  }
  return [...tools.values()];
}

export function userMessages(request: Request): ModelContent[] {
  for (const item of request.input) {
    if (item.type && !['message', 'additional_tools', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'reasoning'].includes(item.type)) {
      throw new BridgeError(`Unsupported input item: ${item.type}. Start a fresh Claude chat if this history came from another provider.`);
    }
  }
  return request.input.filter(i => i.role === 'user' && (!i.type || i.type === 'message')).map(i => modelContent(i.content));
}

export function instructionsFor(request: Request): string {
  return [request.instructions, ...request.input.filter(i => ['system', 'developer'].includes(i.role ?? '') && (!i.type || i.type === 'message')).map(i => textContent(i.content)),
    'For web research, look for mcp__codex_apps__search_service_web_run in ALL_TOOLS inside the exec runtime. If present, read that entry’s complete description and call tools.mcp__codex_apps__search_service_web_run with its declared schema; it supports both searching and opening pages. For any nested tool whose declaration is missing, list matching tool names first, then read only the selected full entries. Use their exact argument fields rather than guessing from familiar APIs.',
    'When waiting for a running job, prefer one existing watcher or completion-wait tool over repeated sleep-and-status shell commands. For GitHub Actions, use gh run watch with --interval 60 --compact --exit-status when available. Keep repetitive watcher output in a local log and return the exit status with relevant failure details. If execution yields a session or cell ID, wait on that same ID using the declared tool schema; a yielded wait is not a failed job. Respect tool wait limits, cancellation, and required progress updates, and do independent work while waiting when possible. Keep polling inside the watcher rather than requesting a new model decision for each unchanged status. For a one-time status question, query once instead of starting a watcher. Use only tools actually exposed by Codex; do not assume a monitor or wake-up tool exists.'
  ].filter(Boolean).join('\n\n');
}

export type Usage = { input_tokens: number; output_tokens: number; cached_tokens: number };
export const emptyUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, cached_tokens: 0 });

export class ResponseStream {
  response: ServerResponse;
  id = `resp_${randomUUID().replaceAll('-', '')}`;
  output: Item[] = [];
  sequence = 0;
  ended = false;
  started = false;
  replayable = true;
  frames: string[] = [];
  bufferedBytes = 0;
  model: string;
  textItem?: Item;
  thinkingItem?: Item;
  constructor(response: ServerResponse, model: string) {
    this.response = response; this.model = model;
  }
  start() {
    if (this.started) return;
    this.started = true;
    this.response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    this.event('response.created', { response: this.body('in_progress') });
    this.event('response.in_progress', { response: this.body('in_progress') });
  }
  attach(response: ServerResponse) {
    this.response = response;
    if (!this.started) return;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    for (const frame of this.frames) response.write(frame);
    if (this.ended) response.end();
  }
  heartbeat() {
    if (this.ended) return;
    this.start();
    this.event('response.in_progress', { response: { id: this.id, object: 'response', status: 'in_progress' } }, false);
  }
  event(type: string, fields: JsonObject, retain = true) {
    if (this.ended) return;
    const frame = `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.sequence++, ...fields })}\n\n`;
    if (retain && this.replayable) {
      this.bufferedBytes += Buffer.byteLength(frame);
      if (this.bufferedBytes <= 4 * 1024 * 1024) this.frames.push(frame);
      else { this.replayable = false; this.frames = []; }
    }
    if (!this.response.destroyed) this.response.write(frame);
  }
  body(status: string, usage = emptyUsage()) {
    return { id: this.id, object: 'response', created_at: Math.floor(Date.now()/1000), model: this.model, status, output: this.output,
      usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, total_tokens: usage.input_tokens + usage.output_tokens, input_tokens_details: { cached_tokens: usage.cached_tokens } }, error: null };
  }
  thinking(delta: string) {
    this.finishText('commentary');
    if (!this.thinkingItem) {
      this.thinkingItem = { type: 'reasoning', id: `rs_${randomUUID()}`, status: 'in_progress', summary: [] };
      this.output.push(this.thinkingItem);
      this.event('response.output_item.added', { output_index: this.output.length-1, item: this.thinkingItem });
      this.event('response.reasoning_summary_part.added', { output_index: this.output.length-1, item_id: this.thinkingItem.id, summary_index: 0, part: { type: 'summary_text', text: '' } });
      this.thinkingItem.summary = [{ type: 'summary_text', text: '' }];
    }
    if (!delta) return;
    const summary = this.thinkingItem.summary as { text: string }[];
    summary[0].text += delta;
    this.event('response.reasoning_summary_text.delta', { output_index: this.output.length-1, item_id: this.thinkingItem.id, summary_index: 0, delta });
  }
  finishThinking() {
    if (!this.thinkingItem) return;
    const item = this.thinkingItem;
    const summary = item.summary as JsonObject[];
    item.status = 'completed';
    this.event('response.reasoning_summary_text.done', { output_index: this.output.length-1, item_id: item.id, summary_index: 0, text: summary[0].text });
    this.event('response.reasoning_summary_part.done', { output_index: this.output.length-1, item_id: item.id, summary_index: 0, part: summary[0] });
    this.event('response.output_item.done', { output_index: this.output.length-1, item });
    this.thinkingItem = undefined;
  }
  text(delta: string) {
    if (!delta) return;
    this.finishThinking();
    if (!this.textItem) {
      this.textItem = { type: 'message', id: `msg_${randomUUID()}`, role: 'assistant', status: 'in_progress', content: [] };
      this.output.push(this.textItem);
      this.event('response.output_item.added', { output_index: this.output.length-1, item: this.textItem });
      this.event('response.content_part.added', { output_index: this.output.length-1, item_id: this.textItem.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      this.textItem.content = [{ type: 'output_text', text: '', annotations: [] }];
    }
    const content = this.textItem.content as { text: string }[];
    content[0].text += delta;
    this.event('response.output_text.delta', { output_index: this.output.length-1, item_id: this.textItem.id, content_index: 0, delta });
  }
  finishText(phase: 'commentary' | 'final_answer') {
    if (!this.textItem) return;
    const item = this.textItem;
    const content = item.content as JsonObject[];
    item.status = 'completed'; item.phase = phase;
    this.event('response.output_text.done', { output_index: this.output.length-1, item_id: item.id, content_index: 0, text: content[0].text });
    this.event('response.content_part.done', { output_index: this.output.length-1, item_id: item.id, content_index: 0, part: content[0] });
    this.event('response.output_item.done', { output_index: this.output.length-1, item });
    this.textItem = undefined;
  }
  tool(tool: Tool, args: JsonObject, callId: string) {
    this.finishThinking();
    this.finishText('commentary');
    const item: Item = { type: tool.kind === 'custom' ? 'custom_tool_call' : 'function_call', id: `fc_${randomUUID()}`, call_id: callId, name: tool.name, status: 'completed', ...(tool.namespace ? { namespace: tool.namespace } : {}) };
    const field = tool.kind === 'custom' ? 'input' : 'arguments';
    const value = tool.kind === 'custom' ? z.string().parse(args.input) : JSON.stringify(args);
    this.output.push(item);
    this.event('response.output_item.added', { output_index: this.output.length-1, item: { ...item, status: 'in_progress', [field]: '' } });
    const prefix = tool.kind === 'custom' ? 'response.custom_tool_call_input' : 'response.function_call_arguments';
    this.event(`${prefix}.delta`, { output_index: this.output.length-1, item_id: item.id, delta: value });
    this.event(`${prefix}.done`, { output_index: this.output.length-1, item_id: item.id, [field]: value });
    item[field] = value;
    this.event('response.output_item.done', { output_index: this.output.length-1, item });
  }
  complete(usage = emptyUsage()) {
    this.finishThinking();
    this.finishText('final_answer');
    this.event('response.completed', { response: this.body('completed', usage) });
    this.ended = true; this.response.end();
  }
  fail(error: Error) {
    this.finishThinking();
    this.event('response.failed', { response: { ...this.body('failed'), error: { code: error instanceof BridgeError ? error.code : 'bridge_error', message: error.message } } });
    this.ended = true; this.response.end();
  }
}
