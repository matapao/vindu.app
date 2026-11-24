import assert from 'node:assert/strict';
import { test } from 'vitest';
import { appEndpoint } from '../src/app-endpoint.js';

const processorApp = { id: 'workshop', name: 'Workshop', asks: ['processors'] };
const storageApp = { id: 'shelf', name: 'Shelf', asks: ['storage'] };

test('the app HTTP service binds requests to an app token and rotates it on restart', async () => {
  const runs: unknown[] = [];
  const notices: unknown[] = [];
  const endpoint = await appEndpoint({
    describe: app => ({ app: app.id }),
    async start(app, input) { runs.push({ app: app.id, input }); return { task: app.id }; },
    notify(app, input) { notices.push({ app: app.id, input }); },
  });
  try {
    endpoint.register(processorApp);
    endpoint.register(storageApp);
    assert.deepEqual(endpoint.env('unregistered'), {});
    const original = endpoint.env(processorApp.id);
    const access = endpoint.env(storageApp.id);
    assert.equal(original.HARNESS_URL, original.CELLER_URL);
    assert.equal(original.HARNESS_TOKEN, original.CELLER_TOKEN);
    const request = (token: string, route: string, input?: unknown, headers?: Record<string, string>) => fetch(`${original.CELLER_URL}${route}`, {
      ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    });
    assert.equal((await request('unknown', '/access')).status, 401);
    assert.deepEqual(await (await request(access.CELLER_TOKEN, '/access')).json(), { app: 'shelf' });
    const input = { processor: 'claude', prompt: 'Review this', app: 'workshop' };
    assert.equal((await request(access.CELLER_TOKEN, '/runs', input)).status, 403);
    assert.deepEqual(runs, []);
    const renewed = endpoint.env(processorApp.id);
    assert.notEqual(renewed.CELLER_TOKEN, original.CELLER_TOKEN);
    assert.equal((await request(original.CELLER_TOKEN, '/access')).status, 401);
    assert.equal((await request(renewed.CELLER_TOKEN, '/runs', input, { origin: 'http://127.0.0.1:9000' })).status, 401);
    assert.equal((await request(renewed.CELLER_TOKEN, '/runs', input, { 'content-type': 'text/plain' })).status, 415);
    assert.deepEqual(runs, []);
    assert.deepEqual(await (await request(renewed.CELLER_TOKEN, '/runs', input)).json(), { task: 'workshop' });
    assert.deepEqual(runs, [{ app: 'workshop', input }]);
    const notice = { title: 'Work ready' };
    assert.deepEqual(await (await request(access.CELLER_TOKEN, '/notify', notice)).json(), { accepted: true });
    assert.deepEqual(notices, [{ app: 'shelf', input: notice }]);
  } finally { await endpoint.close(); }
});
