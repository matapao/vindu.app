import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bodyOf } from './web.js';

export type AppAccess = { id: string; name: string; asks: string[]; folder?: string };

export async function appEndpoint(options: {
  describe(app: AppAccess): unknown;
  current?(app: AppAccess): AppAccess | undefined;
  start(app: AppAccess, input: unknown, signal: AbortSignal): Promise<unknown>;
  notify(app: AppAccess, input: unknown): void;
}) {
  const tokens = new Map<string, AppAccess>();
  const apps = new Map<string, AppAccess>();
  const server = createServer(async (req, res) => {
    const send = (status: number, value: unknown) => {
      if (!res.destroyed) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
    };
    const cancel = new AbortController();
    res.once('close', () => cancel.abort());
    try {
      const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '')?.[1];
      const registered = token ? tokens.get(token) : undefined;
      const current = registered && (options.current ? options.current(registered) : apps.get(registered.id));
      const app = current?.folder === registered?.folder ? current : undefined;
      if (!app || req.headers.host !== `127.0.0.1:${(server.address() as AddressInfo).port}` || req.headers.origin !== undefined) {
        send(401, { error: 'App access is required' });
        return;
      }
      if (req.method === 'GET' && req.url === '/access') {
        send(200, options.describe(app));
      } else if (req.method === 'POST' && (req.url === '/runs' || req.url === '/notify')) {
        if (!req.headers['content-type']?.startsWith('application/json')) {
          send(415, { error: 'Expected JSON' });
          return;
        }
        const input: unknown = JSON.parse((await bodyOf(req, 1_048_576)).toString('utf8'));
        if (req.url === '/runs') {
          if (!app.asks.includes('processors')) { send(403, { error: 'This app did not request processor access' }); return; }
          send(200, await options.start(app, input, cancel.signal));
        } else {
          options.notify(app, input);
          send(200, { accepted: true });
        }
      } else send(404, { error: 'Unknown app request' });
    } catch (error) {
      send(400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    register(app: AppAccess) { apps.set(app.id, app); },
    env(owner: string): Record<string, string> {
      if (!apps.get(owner)?.asks.length) return {};
      for (const [token, app] of tokens) if (app.id === owner) tokens.delete(token);
      const token = randomBytes(32).toString('base64url');
      tokens.set(token, apps.get(owner)!);
      return { CELLER_URL: url, CELLER_TOKEN: token };
    },
    close() {
      tokens.clear();
      server.closeAllConnections();
      return new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
