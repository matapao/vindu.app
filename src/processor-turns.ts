// A task's turns on one of the app's own processors: each turn is one run of its CLI through Celler's harness, in the
// task's folder, with the task's MCP servers, and the CLI's session goes on from one turn to the next. What the CLI asks
// before it acts goes to the task, which puts it to the person in its thread; what it writes, the tools it calls and the
// settings it runs on show there as they come. Its model, effort and the rest are the CLI's own defaults.
import type { AgentSetting, RunHandle, RunProgress, Runtime, TokenUsage } from '@matapao/celler/harness';
import type { Act } from './work.js';
import type { Switch, TaskConnection, TaskProcessor } from './task.js';

/** The longest one turn runs. Its clock stands still while the person is asked. */
const TURN_MS = 60 * 60_000;

/** Each of the CLIs' own tools, as the thread names what it does. */
const KINDS: Record<string, string> = {
  Read: 'read', Write: 'edit', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Bash: 'execute', Grep: 'search', Glob: 'search', WebSearch: 'search', WebFetch: 'fetch',
};

/** Every token the turn's model processed: what it read, wrote and cached. */
const tokensOf = (usage: TokenUsage) => usage.input + usage.output + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;

/** The CLI's own settings as the task's switches: shown as it chose them, with nothing else to pick. */
const switchesOf = (settings: AgentSetting[]): Switch[] => settings.filter(setting => setting.value).map(setting => ({
  id: setting.id, name: setting.name, value: setting.value, type: 'select', via: 'config',
  options: [{ value: setting.value, name: setting.value }],
}));

/** The turn's words: what the window says the person sees and has changed, then the person's own. */
const promptOf = (text: string, context: string) => (context ? `${context}\n\n${text}` : text);

/** The task's connection to the CLI that `runtime` runs. */
export function connectRuntime(task: TaskConnection, runtime: Runtime): TaskProcessor {
  let session: string | undefined; // the CLI's session, once its first turn has one
  let turns = 0;
  let last: RunHandle | undefined; // the latest turn's run: the one a close stops and waits for

  return {
    async send({ text, context, attachments, signal }) {
      signal.throwIfAborted();
      const turn = ++turns;
      const calls = new Set<string>();
      let unnamed = 0;
      let writing = ''; // the message the CLI is writing, as far as the thread has it
      const progress = (event: RunProgress) => {
        if (event.type === 'session') session = event.sessionId;
        else if (event.type === 'settings') task.settings(switchesOf(event.settings));
        else if (event.type === 'text') {
          // the same message, further on; or a new one, set apart from the last
          task.text(event.text.startsWith(writing) ? event.text.slice(writing.length) : `\n\n${event.text}`);
          writing = event.text;
        } else if (event.type === 'tool') {
          const id = `${turn}-${event.call ?? `call-${++unnamed}`}`;
          calls.add(id);
          const act: Act = { type: 'call', id, title: event.summary, status: 'pending', ...(KINDS[event.tool] ? { kind: KINDS[event.tool] } : {}),
            ...(event.helper ? { input: event.helper } : {}) };
          task.activity(act);
        } else if (event.type === 'helper-done') {
          const id = `${turn}-${event.call}`;
          calls.delete(id);
          task.activity({ type: 'call', id, status: event.ok ? 'completed' : 'failed' });
        }
      };
      const handle = runtime.run({
        cwd: task.cwd, prompt: promptOf(text, context), systemPrompt: '', model: '', sessionId: session ?? '', resume: session !== undefined,
        mcpServers: task.mcpServers, ask: (question, asked) => task.ask(question, asked),
        attachments: attachments.map(({ path, name, type }) => ({ path, name, type })),
        purpose: task.readsOnly ? 'read' : 'work', timeoutMs: TURN_MS,
      }, progress);
      last = handle;
      const cancel = () => handle.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        const result = await handle.done;
        const reply = { text: result.text, usage: { totalTokens: tokensOf(result.usage) }, costUsd: result.costUsd };
        if (result.ok || result.cancelled || signal.aborted) return reply;
        throw new Error(result.error || 'The processor did not finish the turn.');
      } finally {
        signal.removeEventListener('abort', cancel);
        for (const id of calls) task.activity({ type: 'call', id, status: 'completed' }); // the turn is over, and its calls with it
      }
    },
    /** The task closed: its turn, if one runs, is stopped, and what it left is gone before the close is done. */
    async close() {
      last?.cancel();
      await last?.done.catch(() => undefined);
      await last?.cleaned;
    },
  };
}
