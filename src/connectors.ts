import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client, SSEClientTransport, StreamableHTTPClientTransport, isCallToolResult, type Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { toolResourceUri, toolVisibleTo } from '@matapao/vindu/server';
import type { Adapter, NodeConfig, Run, Write } from '@matapao/celler';
import { z } from 'zod';

const name = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const value = z.object({ name: z.string().min(1), value: z.string().optional(), key: z.string().optional(), prefix: z.string().optional() });
const secret = z.object({ name: z.string().min(1), value: z.string() });
const commonServer = { name, auth: z.literal('oauth').optional(), secrets: z.array(secret).optional() };
const httpAddress = z.url().refine(raw => {
  const url = URL.parse(raw);
  return !!url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash;
}, 'Expected an HTTP address without embedded credentials or a fragment');

const mcpServer = z.union([
  z.object({ ...commonServer, type: z.literal('stdio').optional(), command: z.string().min(1), args: z.array(z.string()).default([]), env: z.array(value).optional() }),
  z.object({ ...commonServer, type: z.enum(['http', 'sse']), url: httpAddress, headers: z.array(value).optional() }),
]);

/** One MCP server as configured by the person. Keys are resolved only in the host. */
export type ServerSpec = z.input<typeof mcpServer>;

const auth = z.object({ type: z.enum(['bearer', 'basic', 'header', 'query']), name: z.string().optional(), secret: z.string().optional() });
const limits = { timeoutMs: 30_000, maxBytes: 2_000_000 };
const httpConnector = z.object({
  base: httpAddress.refine(raw => !URL.parse(raw)?.search, 'The connector base cannot contain a query'),
  auth: auth.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  reads: z.array(z.string().regex(/^[A-Z]+ \/[^?#]*$/)).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  maxBytes: z.number().int().positive().max(25_000_000).optional(),
});

const connector = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('http'), http: httpConnector }),
  z.object({ kind: z.literal('mcp'), mcp: z.record(z.string(), z.unknown()) }),
]).and(z.object({ name: name.optional(), title: z.string().optional(), description: z.string().optional() }));

type HttpSpec = z.output<typeof httpConnector>;
type ConnectorCommon = { name: string; title: string; description?: string; notes: string[]; skill?: { dir: string; files: string[] } };
export type ConnectorSpec = ConnectorCommon & (
  { kind: 'http'; http: HttpSpec; mcp?: never } |
  { kind: 'mcp'; mcp: ServerSpec; http?: never }
);

/** Read the person's connector manifests. Other files are not trusted as executable configuration. */
export function loadConnectors(directory: string): { connectors: ConnectorSpec[]; notes: string[]; failed: Record<string, string> } {
  const connectors: ConnectorSpec[] = [];
  const failed: Record<string, string> = Object.create(null);
  const seen = new Set<string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { connectors, notes: [], failed };
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(directory, entry.name);
    try {
      const file = path.join(dir, 'connector.json');
      if (!fs.existsSync(file)) continue;
      const parsed = connector.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      const id = name.parse(parsed.name ?? entry.name);
      if (seen.has(id)) throw new Error('Another connector has this name');
      const common = {
        name: id,
        title: parsed.title || id,
        ...(parsed.description ? { description: parsed.description } : {}),
        notes: [],
        ...(fs.existsSync(path.join(dir, 'SKILL.md')) ? { skill: { dir, files: [] } } : {}),
      };
      connectors.push(parsed.kind === 'http'
        ? { ...common, kind: 'http', http: parsed.http }
        : { ...common, kind: 'mcp', mcp: mcpServer.parse({ ...parsed.mcp, name: id }) });
      seen.add(id);
    } catch {
      failed[entry.name] = 'Invalid or duplicate connector configuration';
    }
  }
  return { connectors, notes: Object.entries(failed).map(([id, why]) => `${id}: ${why}`), failed };
}

export function configuredServers(servers: readonly ServerSpec[]): ConnectorSpec[] {
  return servers.flatMap(server => {
    const parsed = mcpServer.safeParse(server);
    if (!parsed.success) return [];
    return [{ name: parsed.data.name, title: parsed.data.name, kind: 'mcp', mcp: parsed.data, notes: [] }];
  });
}

type CallAdapter = Extract<Adapter, { call: unknown }>;
type WriteAdapter = Extract<Adapter, { send: unknown }>;
export type ConnectorResult = Awaited<ReturnType<CallAdapter['call']>>;
export type ConnectorObservation = { connector: string; tool: string; input: Record<string, unknown>; result: ConnectorResult; run: Run };
export type ConnectorOptions = {
  key?(connector: ConnectorSpec): string | undefined | Promise<string | undefined>;
  server?(server: ServerSpec): Promise<ServerSpec | undefined>;
  onResult?(observation: ConnectorObservation): void;
  readsOnly?: boolean;
  signal?: AbortSignal;
  /** A live revocation check for resources that do not themselves start a Celler run. */
  mayUse?(connector: string): boolean;
};
type ConnectorTool = Extract<NodeConfig, { kind: 'tool' }>['definition'];

const HTTP_READ = ['GET', 'HEAD'];
const HTTP_WRITE = ['POST', 'PUT', 'PATCH', 'DELETE'];
const forbiddenHeaders = /^(authorization|proxy-authorization|host|content-length|transfer-encoding|connection|cookie|expect|origin|referer|forwarded|x-forwarded-.*|sec-.*|upgrade|trailer|te)$/i;
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const httpInput = z.strictObject({
  path: z.string().min(1),
  method: z.string().optional(),
  query: z.record(z.string(), z.union([scalar, z.array(scalar)])).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.json().optional(),
  contentType: z.string().optional(),
});
const approvedHttp = z.strictObject({
  configuration: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string().nullable(),
});
const approvedMcp = z.strictObject({ configuration: z.string(), arguments: z.record(z.string(), z.json()) });
const fingerprint = (data: unknown): string => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const errorResult = (text: string): ConnectorResult => ({ isError: true, content: [{ type: 'text', text }] });

function observe(options: ConnectorOptions, event: ConnectorObservation): void {
  // Rendering a completed tool result cannot turn a successful delivery into an uncertain one.
  try { options.onResult?.(event); } catch { /* Celler still retains the definitive result. */ }
}

function declaredRead(http: HttpSpec, method: string, pathname: string): boolean {
  return (http.reads ?? []).some(rule => {
    const [declaredMethod, pattern] = rule.split(' ', 2);
    if (declaredMethod !== method) return false;
    const escaped = pattern.split('**').map(part => part.split('*').map(piece => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- every metacharacter is escaped first; * and ** become [^/]* and .*
    return new RegExp(`^${escaped}$`).test(pathname);
  });
}

function destination(http: HttpSpec, raw: string): URL {
  const base = new URL(http.base);
  const prefix = base.pathname.replace(/\/+$/, '');
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\#\x00-\x20]/.test(raw) || /%(?:00|25|2f|5c)/i.test(raw.split('?')[0])) {
    throw new Error('Expected a path under the connector base');
  }
  const url = new URL(base.origin + prefix + raw);
  if (url.origin !== base.origin || !(url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
    throw new Error('The request must stay under the connector base');
  }
  if (http.auth?.type === 'query' && url.searchParams.has(http.auth.name ?? 'api_key')) throw new Error('The connector supplies its own key');
  return url;
}

function requestHeaders(http: HttpSpec, supplied: Record<string, string>): Record<string, string> {
  const credential = http.auth?.type === 'header' ? (http.auth.name ?? 'x-api-key').toLowerCase() : undefined;
  for (const key of Object.keys(supplied)) {
    if (forbiddenHeaders.test(key) || key.toLowerCase() === credential || Object.keys(http.headers ?? {}).some(name => name.toLowerCase() === key.toLowerCase())) {
      throw new Error('The request cannot replace a connector header');
    }
  }
  return Object.fromEntries(new Headers(supplied));
}

function prepareHttp(http: HttpSpec, input: Record<string, unknown>, write: boolean) {
  const parsed = httpInput.parse(input);
  const url = destination(http, parsed.path);
  for (const [key, set] of Object.entries(parsed.query ?? {})) {
    if (http.auth?.type === 'query' && key === (http.auth.name ?? 'api_key')) throw new Error('The connector supplies its own key');
    for (const item of Array.isArray(set) ? set : [set]) url.searchParams.append(key, String(item));
  }
  const method = parsed.method ?? 'GET';
  const basePath = new URL(http.base).pathname.replace(/\/+$/, '');
  const declared = declaredRead(http, method, url.pathname.slice(basePath.length) || '/');
  if (write ? !HTTP_WRITE.includes(method) : !(HTTP_READ.includes(method) || declared)) {
    throw new Error(write ? 'Expected a write method' : 'The connector has not declared this request read-only');
  }
  const headers = requestHeaders(http, parsed.headers ?? {});
  let body: string | null = null;
  if (parsed.body !== undefined) {
    if (HTTP_READ.includes(method)) throw new Error('This HTTP method has no request body');
    const ownType = new Headers(http.headers).get('content-type');
    const contentType = parsed.contentType ?? headers['content-type'] ?? ownType ?? (typeof parsed.body === 'string' ? 'text/plain' : 'application/json');
    if ((headers['content-type'] ?? ownType) !== null && (headers['content-type'] ?? ownType) !== contentType) {
      throw new Error('The request has conflicting content types');
    }
    if (!ownType) headers['content-type'] = new Headers({ 'content-type': contentType }).get('content-type')!;
    if (contentType.split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded' && parsed.body && typeof parsed.body === 'object' && !Array.isArray(parsed.body)) {
      body = new URLSearchParams(Object.entries(parsed.body).map(([key, item]) => [key, typeof item === 'string' ? item : JSON.stringify(item)])).toString();
    } else {
      body = typeof parsed.body === 'string' && !/json/i.test(contentType) ? parsed.body : JSON.stringify(parsed.body);
    }
  }
  return { method, destination: url.href, headers, body };
}

async function responseText(response: Response, maxBytes: number): Promise<string | undefined> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(parts, size).toString('utf8');
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function containsCredential(text: string, credentials: readonly string[]): boolean {
  return credentials.some(key => !!key && [key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1), Buffer.from(key).toString('base64')].some(value => text.includes(value)));
}

async function executeHttp(connector: ConnectorSpec & { kind: 'http' }, approved: ReturnType<typeof prepareHttp>, getKey: ConnectorOptions['key'], signal: AbortSignal, receipt?: string): Promise<ConnectorResult> {
  const { http } = connector;
  const headers = new Headers({ accept: 'application/json', ...http.headers, ...approved.headers });
  const url = new URL(approved.destination);
  const credential = http.auth;
  const key = credential ? await getKey?.(connector) : undefined;
  if (credential && !key) throw new Error('The connector requires a key');
  if (key && credential) {
    if (credential.type === 'bearer') headers.set('authorization', `Bearer ${key}`);
    if (credential.type === 'basic') headers.set('authorization', `Basic ${Buffer.from(key).toString('base64')}`);
    if (credential.type === 'header') headers.set(credential.name ?? 'x-api-key', key);
    if (credential.type === 'query') url.searchParams.set(credential.name ?? 'api_key', key);
  }
  if (receipt && !headers.has('idempotency-key')) headers.set('idempotency-key', receipt);
  const response = await fetch(url, {
    method: approved.method,
    headers,
    body: approved.body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(http.timeoutMs ?? limits.timeoutMs)]),
    redirect: 'manual',
  });
  const text = await responseText(response, http.maxBytes ?? limits.maxBytes);
  if (text === undefined) return errorResult(`HTTP ${response.status}: response exceeds the connector limit`);
  const credentials = [
    ...(key ? [key] : []),
    ...credentialValues(Object.entries(http.headers ?? {}).map(([name, value]) => ({ name, value }))),
  ];
  if (containsCredential(text, credentials)) return errorResult('The response contained a connector credential and was withheld');
  return { content: [{ type: 'text', text }], ...(response.ok ? {} : { isError: true }) };
}

function httpDefinition(connector: ConnectorSpec & { kind: 'http' }, write: boolean): ConnectorTool {
  const method = write ? HTTP_WRITE : [...new Set([...HTTP_READ, ...(connector.http.reads ?? []).map(rule => rule.split(' ', 1)[0])])];
  return {
    title: connector.title,
    ...(connector.description ? { description: connector.description } : {}),
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, method: { type: 'string', enum: method }, query: { type: 'object' }, headers: { type: 'object' }, body: {}, contentType: { type: 'string' } },
      required: write ? ['method', 'path'] : ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: !write },
  };
}

function httpAdapter(connector: ConnectorSpec & { kind: 'http' }, write: boolean, configuration: string, options: ConnectorOptions): Adapter {
  const { http } = connector;
  if (!write) {
    return {
      async call(run, input, signal) {
        const result = await executeHttp(connector, prepareHttp(http, input, false), options.key, signal);
        observe(options, { connector: connector.name, tool: 'read', input, result, run });
        return result;
      },
    };
  }
  function verify(packet: Write) {
    const approved = approvedHttp.parse(packet.content);
    const base = new URL(http.base);
    const url = new URL(packet.destination);
    const prefix = base.pathname.replace(/\/+$/, '');
    const relative = url.pathname.slice(prefix.length) + url.search;
    if (packet.account !== connector.name || packet.files.length || approved.configuration !== configuration ||
        !HTTP_WRITE.includes(packet.operation) || destination(http, relative).href !== packet.destination) {
      throw new Error('The connector has changed since review');
    }
    requestHeaders(http, approved.headers);
    return { ...approved, destination: packet.destination, method: packet.operation };
  }
  return {
    async prepare(_run, input) {
      const { method, destination, headers, body } = prepareHttp(http, input, true);
      return { account: connector.name, destination, operation: method, content: { configuration, headers, body }, files: [] };
    },
    verify(_run, packet) { verify(packet); },
    async send(run, packet, receipt, signal) {
      const approved = verify(packet);
      const result = await executeHttp(connector, approved, options.key, signal ?? new AbortController().signal, receipt);
      observe(options, { connector: connector.name, tool: 'write', input: { method: approved.method, destination: approved.destination, headers: approved.headers, body: approved.body }, result, run });
      return result;
    },
  };
}

function serverEntries(entries: { name: string; value?: string; key?: string }[] | undefined, secrets: { name: string; value: string }[] | undefined) {
  if (entries?.some(item => item.key !== undefined)) throw new Error('A connector key is not available');
  return Object.fromEntries([...(entries ?? []), ...(secrets ?? [])].map(item => [item.name, item.value ?? '']));
}

async function withMcp<T>(spec: ServerSpec, signal: AbortSignal, call: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> {
  if (spec.auth === 'oauth') throw new Error('The MCP connector needs its own OAuth sign-in');
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs)]);
  deadline.throwIfAborted();
  const client = new Client({ name: 'vindu', version: '0.1.0' });
  const guardedFetch: typeof fetch = (request, init) => fetch(request, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline });
  const transport = 'command' in spec
    ? new StdioClientTransport({ command: spec.command, args: spec.args, env: serverEntries(spec.env, spec.secrets), stderr: 'pipe' })
    : spec.type === 'sse'
      ? new SSEClientTransport(new URL(spec.url), { fetch: guardedFetch, requestInit: { headers: serverEntries(spec.headers, spec.secrets), redirect: 'error' } })
      : new StreamableHTTPClientTransport(new URL(spec.url), { fetch: guardedFetch, requestInit: { headers: serverEntries(spec.headers, spec.secrets), redirect: 'error' } });
  const close = () => { void transport.close().catch(() => {}); };
  deadline.addEventListener('abort', close, { once: true });
  try {
    await client.connect(transport);
    deadline.throwIfAborted();
    return await call(client, deadline);
  } finally {
    deadline.removeEventListener('abort', close);
    await transport.close().catch(() => {});
  }
}

async function listMcp(client: Client, signal: AbortSignal): Promise<Tool[]> {
  const tools: Tool[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { signal });
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (!cursor || seen.has(cursor) || tools.length >= 500 || seen.size >= 20) break;
    seen.add(cursor);
  } while (cursor);
  return tools.slice(0, 500);
}

function credentialValues(entries: { name: string; value?: string }[], all = false): string[] {
  return entries.flatMap(({ name, value }) => {
    if (!value || (!all && !/auth|key|token|secret|pass|cookie/i.test(name))) return [];
    const token = /^(?:bearer|basic)\s+(.+)$/i.exec(value)?.[1];
    return token ? [value, token] : [value];
  });
}

function mcpCredentials(spec: ServerSpec): string[] {
  const values = 'command' in spec ? spec.env ?? [] : spec.headers ?? [];
  return [...credentialValues(spec.secrets ?? [], true), ...credentialValues(values)];
}

function mcpDestination(spec: ServerSpec): string {
  return 'command' in spec ? JSON.stringify([spec.command, ...(spec.args ?? [])]) : spec.url;
}

function mcpAdapter(connector: ConnectorSpec, spec: ServerSpec, tool: Tool, configuration: string, options: ConnectorOptions): Adapter {
  async function deliver(run: Run, input: Record<string, unknown>, signal: AbortSignal): Promise<ConnectorResult> {
    const result = await withMcp(spec, signal, async (client, deadline) => {
      const current = (await listMcp(client, deadline)).find(item => item.name === tool.name);
      if (!current || fingerprint(current) !== fingerprint(tool)) throw new Error('The upstream tool changed before the call');
      const value = await client.callTool({ name: tool.name, arguments: input }, { signal: deadline });
      if (!isCallToolResult(value)) return errorResult('The upstream connector did not return a completed result');
      const encoded = JSON.stringify(value);
      const credentials = mcpCredentials(spec);
      if (Buffer.byteLength(encoded) > limits.maxBytes) return errorResult('The upstream result exceeds the connector limit');
      if (containsCredential(encoded, credentials)) return errorResult('The response contained a connector credential and was withheld');
      return value as ConnectorResult;
    });
    observe(options, { connector: connector.name, tool: tool.name, input, result, run });
    return result;
  }
  if (tool.annotations?.readOnlyHint === true) return { call: deliver };
  function verify(packet: Write) {
    const approved = approvedMcp.parse(packet.content);
    if (packet.account !== connector.name || packet.destination !== mcpDestination(spec) ||
        packet.operation !== tool.name || packet.files.length || approved.configuration !== configuration) {
      throw new Error('The MCP connector has changed since review');
    }
    return approved.arguments;
  }
  const adapter: WriteAdapter = {
    async prepare(_run, input) {
      const args = z.record(z.string(), z.json()).parse(input);
      return { account: connector.name, destination: mcpDestination(spec), operation: tool.name, content: { configuration, arguments: args }, files: [] };
    },
    verify(_run, packet) { verify(packet); },
    async send(run, packet, _receipt, signal) { return deliver(run, verify(packet), signal ?? new AbortController().signal); },
  };
  return adapter;
}

/** Translate the configured connector tools into immutable Celler graph bindings and host-owned adapters. */
export async function connectorTools(connectors: readonly ConnectorSpec[], options: ConnectorOptions = {}) {
  const nodes: Extract<NodeConfig, { kind: 'tool' }>[] = [];
  const appNodes: typeof nodes = [];
  const adapters = new Map<string, Adapter>();
  const notes: string[] = [];
  const ids = new Set<string>();
  const resources = new Map<string, { spec: ServerSpec; tools: Tool[] }>();
  const lifetime = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
  function bind(connector: ConnectorSpec, operation: string, definition: ConnectorTool, configuration: string, adapter: Adapter, tool?: Tool) {
    const id = `${connector.name}.${operation}`;
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(id) || ids.has(id)) return;
    ids.add(id);
    // Stable for the same configuration; changes cannot replace an active or pending adapter.
    const adapterId = `connector.${fingerprint([id, configuration])}`;
    adapters.set(adapterId, adapter);
    const node = { kind: 'tool', id, definition, target: { adapter: adapterId } } as const;
    if (!tool || toolVisibleTo(tool, 'model')) nodes.push(node);
    if (tool && toolVisibleTo(tool, 'app')) appNodes.push(node);
  }
  for (const connector of connectors) {
    options.signal?.throwIfAborted();
    if (connector.kind === 'http') {
      const configuration = fingerprint(connector.http);
      bind(connector, 'read', httpDefinition(connector, false), configuration, httpAdapter(connector, false, configuration, options));
      if (!options.readsOnly) bind(connector, 'write', httpDefinition(connector, true), configuration, httpAdapter(connector, true, configuration, options));
      continue;
    }
    try {
      const spec = options.server ? await options.server(connector.mcp) : connector.mcp;
      if (!spec) continue;
      const list = await withMcp(spec, signal, listMcp);
      const credentials = mcpCredentials(spec);
      const usable = list.filter(tool => (!options.readsOnly || tool.annotations?.readOnlyHint === true) &&
        !containsCredential(JSON.stringify(tool), credentials));
      resources.set(connector.name, { spec, tools: usable });
      for (const tool of usable) {
        const configuration = fingerprint([spec, tool]);
        bind(connector, tool.name, tool as ConnectorTool, configuration, mcpAdapter(connector, spec, tool, configuration, options), tool);
      }
    } catch {
      options.signal?.throwIfAborted();
      notes.push(`${connector.title} could not be reached to list its tools.`);
    }
  }
  const allowed = (server: string) => !signal.aborted && options.mayUse?.(server) !== false;
  return {
    nodes, appNodes, adapters, notes,
    tools(server: string) { return allowed(server) ? structuredClone(resources.get(server)?.tools) : undefined; },
    async read(server: string, uri: string) {
      const resource = resources.get(server);
      if (!allowed(server) || !resource || !resource.tools.some(tool => toolResourceUri(tool) === uri)) {
        throw new Error('The MCP App resource was not declared by this connector');
      }
      const { spec } = resource;
      return withMcp(spec, signal, async (client, deadline) => {
        const response = await client.readResource({ uri }, { signal: deadline });
        if (!allowed(server)) throw new Error('The connector is no longer available');
        const contents = response.contents.filter(item => item.uri === uri);
        const data = JSON.stringify(contents);
        if (!contents.length || Buffer.byteLength(data) > limits.maxBytes || containsCredential(data, mcpCredentials(spec))) {
          throw new Error('The MCP App resource could not be loaded');
        }
        return { contents };
      });
    },
    async close() { lifetime.abort(); resources.clear(); },
  };
}
