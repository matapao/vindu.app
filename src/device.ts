// The device's own data, as an MCP server the app runs for a task, only where the person's settings turn it on
// (settings.device). Each tool reads one kind of the person's data and asks them, in the window, before its first read
// in a task; each read is kept in the task's record as exact, and the model is told its id. Here is what the app reads
// the same way on every system: the clipboard's text, and the device's locale, time zone and screens. Contacts,
// calendars, photos and location are each system's own (Windows' agent registry, Android's AppFunctions, Apple's App
// Intents): the person adds those as MCP servers of their own; nothing here stands in for them.
import crypto from 'node:crypto';
import http from 'node:http';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';

/** One kind of the device's data: what the person is asked (once a task), and how it is read. */
export type DeviceTool = { name: string; description: string; asks: string; read: () => Promise<unknown> | unknown };
export type DeviceOptions = {
  tools: DeviceTool[];
  ask: (what: string) => Promise<boolean>;       // the person's yes, in the window
  keep: (tool: string, value: unknown) => string; // into the record, as exact: its id
  log: (e: Record<string, unknown>) => void;
};
export type Device = { url: string; close: () => Promise<void> };

export async function startDevice(o: DeviceOptions): Promise<Device> {
  const token = crypto.randomBytes(16).toString('hex');
  const allowed = new Set<string>(); const asking = new Map<string, Promise<boolean>>();
  const yes = (t: DeviceTool) => { // one ask for calls that come together
    if (allowed.has(t.name)) return Promise.resolve(true);
    let p = asking.get(t.name);
    if (!p) { p = o.ask(t.asks).then(y => { asking.delete(t.name); o.log({ device: t.name, asked: t.asks, yes: y }); if (y) allowed.add(t.name); return y; }); asking.set(t.name, p); }
    return p;
  };
  const serverFor = () => {
    const s = new McpServer({ name: 'device', version: '0.1.0' }); // no instructions of the app's: each tool says what it reads, and that the person is asked first
    for (const t of o.tools) s.registerTool(t.name, { description: `${t.description} The person is asked first, once a task.`, inputSchema: z.object({}), annotations: { readOnlyHint: true, openWorldHint: false } }, async () => {
      if (!(await yes(t))) return { content: [{ type: 'text' as const, text: `not read: the person said no to ${t.asks}` }], isError: true };
      const value = await t.read(); const id = o.keep(t.name, value); o.log({ device: t.name, read: id });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ id, ...((value && typeof value === 'object' && !Array.isArray(value)) ? value : { value }) }) }] };
    });
    return s;
  };
  const node = toNodeHandler(createMcpHandler(() => serverFor()));
  const server = http.createServer((req, res) => { if (req.url?.split('?')[0] !== `/mcp/${token}`) { res.writeHead(404).end(); return; } void node(req, res); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); // loopback only
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/mcp/${token}`, close: () => new Promise<void>(r => { server.close(() => r()); server.closeAllConnections?.(); }) };
}
