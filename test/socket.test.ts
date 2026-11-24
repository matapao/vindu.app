import { afterEach, expect, test, vi } from 'vitest';
import { connect } from '../src/socket.js';
import { readPageRequest } from '../src/socket-messages.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('page requests require an argument list and calls require a numeric request id', () => {
  const call = { t: 'call', ch: 'list', a: [], id: 1 };
  const post = { t: 'post', ch: 'ready', a: [true] };
  for (const message of [call, post]) expect(readPageRequest(JSON.stringify(message))).toEqual(message);
  for (const id of [null, '1', 1.5, {}, 0, Number.MAX_SAFE_INTEGER + 1]) {
    expect(readPageRequest(JSON.stringify({ ...call, id }))).toBeUndefined();
  }
  for (const message of [null, [], { ...call, a: undefined }, { ...post, a: false }, { ...call, ch: 3 }]) {
    expect(readPageRequest(JSON.stringify(message))).toBeUndefined();
  }
});

test('a failed first connection rejects queued changes and reconnects with fresh page state', async () => {
  vi.useFakeTimers();
  const connections: StubSocket[] = [];
  class StubSocket {
    static readonly OPEN = 1;
    readonly sent: string[] = [];
    readyState = 0;
    onopen?: () => void;
    onclose?: () => void;
    constructor() { connections.push(this); }
    send(message: string) { this.sent.push(message); }
  }
  const reload = vi.fn();
  vi.stubGlobal('WebSocket', StubSocket);
  vi.stubGlobal('location', { pathname: '/test/', host: 'localhost', protocol: 'http:', reload });
  vi.stubGlobal('document', { getElementById: () => ({}) });
  const socket = connect();
  const pending = socket.invoke('task:create', { id: 'test-task' });
  connections[0].onclose!();
  await expect(pending).rejects.toThrow('the app stopped');
  vi.advanceTimersByTime(300);
  connections[1].readyState = StubSocket.OPEN;
  connections[1].onopen!();
  expect(connections[1].sent).toEqual([]);
  expect(reload).toHaveBeenCalledOnce();
});
