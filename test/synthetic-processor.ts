// The tests' processor, in place of a harness: it calls no model. It receives the same UI endpoint a harness gives its
// MCP client.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Switch, TaskConnection, TaskProcessor } from '../src/task.js';

export const processors = [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }];

const page = '<!doctype html><title>Run</title><input id="cmd" value="npm test"><button id="go">Run</button><p id="out"></p>'
  + '<script>document.getElementById("go").onclick = async () => { await task.send({command: document.getElementById("cmd").value}); document.getElementById("out").textContent = "sent"; };</script>';

export function connectSyntheticProcessor(task: TaskConnection): TaskProcessor {
  const switches: Switch[] = [{
    id: 'report', name: 'Report', value: 'short', type: 'select', via: 'config',
    options: [{ value: 'short', name: 'Short' }, { value: 'full', name: 'Full' }],
  }];
  task.settings(switches);
  return {
    set(id, value) {
      if (id === 'report') switches[0].value = value;
      task.settings(switches);
    },
    async send({ text, context, signal }) {
      const endpoint = task.mcpServers.find(server => server.name === 'ui')!;
      const client = new Client({ name: 'synthetic-processor', version: '1' });
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = await client.callTool({ name, arguments: args });
        const block = result.content[0];
        if (block?.type !== 'text' || result.isError) throw new Error(block?.type === 'text' ? block.text : 'Missing text result');
        return JSON.parse(block.text);
      };
      const out: Record<string, unknown> = { prompt: text, context, servers: task.mcpServers.map(server => server.name), report: switches[0].value };
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } }));
        if (/^Run the tests/i.test(text)) {
          task.activity({ type: 'call', id: 'tests', title: 'npm test', status: 'pending' });
          out.picked = await task.ask({ call: 'tests', tool: 'Bash', title: 'npm test', input: { command: 'npm test' },
            options: [{ optionId: 'allow', name: 'Yes', kind: 'allow_once' }, { optionId: 'reject', name: 'No', kind: 'reject_once' }] }, signal);
          if ((out.picked as { option?: string } | null)?.option === 'allow' && !signal.aborted) {
            const from = task.observe({ connector: 'checks', tool: 'test_report', input: {}, result: {
              content: [{ type: 'text', text: JSON.stringify([{ suite: 'invoices', passed: 41, failed: 1 }]) }],
            } });
            task.activity({ type: 'call', id: 'tests', status: 'completed' });
            out.form = await task.ask({ call: 'suite', tool: 'form', title: 'Suite', options: [], form: {
              message: 'Which suite should run again?', fields: [{ name: 'suite', title: 'Suite', type: 'string', required: true }],
            } }, signal);
            if (!signal.aborted) out.page = await task.ask({ call: 'link', tool: 'link', title: 'Sign in', options: [], form: {
              message: 'Sign in to the ledger service', url: 'https://ledger.example/oauth/authorize?state=x1',
            } }, signal);
            if (!signal.aborted) out.account = await call('show_view', { name: 'tests', title: 'Tests', panels: [{ card: 'table', from }] });
          }
        } else if (text.includes('[views]')) {
          out.look = await call('look');
          out.read = await call('read_view', { view: 't1', last: 1 });
          out.ran = await call('act_in_view', { view: 't1', action: 'run', command: 'echo from-the-model' });
          out.declined = await call('act_in_view', { view: 't1', action: 'run', command: 'rm -rf build' });
          out.after = await call('look');
        } else if (/a page that sends/i.test(text)) {
          out.account = await call('show_view', { name: 'run', title: 'Run a command', panels: [{ card: 'page', id: 'runner', html: page, height: 200 }] });
        }
        const reply = JSON.stringify(out);
        task.text(reply);
        return { text: reply };
      } finally { await client.close(); }
    },
  };
}
