import { connectorTools, type ConnectorSpec } from './connectors.js';
import { withKeys } from './keyrefs.js';
import { APP } from './desktop-settings.js';
import type { DesktopHost } from './desktop-host.js';
import type { TaskSetup, TaskRouter } from './task.js';

type ToolScope = {
  cwd: string;
  harness: string;
  readsOnly: boolean;
  chosen: ConnectorSpec[];
  router: TaskRouter;
  signal: AbortSignal;
};

/** Each invocation rechecks that the connector is still set up, including reads requested by live view sources. */
export async function bindTaskTools(host: DesktopHost, scope: ToolScope) {
  const { celler } = host;
  const { keyOf, keyNamed } = host.connectors;
  const { cwd, harness, readsOnly, chosen, signal, router } = scope;
  const mayUse = (name: string) => host.connectors.availableConnectors().connectors.some(connector => connector.name === name);
  const tools = await connectorTools(chosen, {
    signal, mayUse,
    key: keyOf, readsOnly,
    server: async server => (await withKeys([server], keyNamed)).servers[0],
  });
  const callTool = async (server: string, tool: string, args: unknown, audience: 'app' | 'source' | 'consumer' = 'app', signal?: AbortSignal) => {
    const readOnly = audience === 'source';
    const node = (audience === 'app' ? tools.appNodes : tools.nodes).find(candidate => candidate.id === `${server}.${tool}`);
    if (!node || !mayUse(server) || readOnly && node.definition.annotations?.readOnlyHint !== true) throw new Error('This connector tool is unavailable to the view');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected named tool arguments');
    let entry: string | undefined;
    const result = await celler.callTool({
      owner: APP.id, processor: harness, cwd, node, adapters: tools.adapters, mayUse,
      signal: signal ? AbortSignal.any([signal, scope.signal]) : scope.signal,
      input: args as Record<string, unknown>, ask: readOnly ? undefined : (question, signal) => router.ask?.(question, signal) ?? Promise.resolve(null),
      observed: output => { entry = router.observe?.(output); },
    });
    return { result, entry };
  };
  type Source = Parameters<NonNullable<NonNullable<TaskSetup['sources']>['source']>>[0];
  const readSource = async (source: Source) => {
    if (!source.tool) throw new Error('A view source must name a read tool');
    const { entry, result } = await callTool(source.server, source.tool, source.args, 'source');
    if (result.isError || !entry) throw new Error('The connector read could not be completed');
    return entry;
  };
  const bindings: Pick<TaskSetup, 'callTool' | 'appsProvider' | 'sources'> = {
    callTool: async (server, tool, args, signal) => (await callTool(server, tool, args, 'consumer', signal)).result,
    appsProvider: { tools: tools.tools, read: tools.read, call: async (server, tool, args) => (await callTool(server, tool, args)).result },
    sources: {
      isRead: (server, tool) => tools.nodes.some(node => node.id === `${server}.${tool}` && node.definition.annotations?.readOnlyHint === true && mayUse(server)),
      source: readSource,
      watch(source, seconds, onRead, onError) {
        let closed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const again = () => {
          if (closed) return;
          timer = setTimeout(async () => {
            try {
              const result = await readSource(source);
              if (!closed) onRead(result);
            } catch (error) {
              if (!closed) onError?.(error instanceof Error ? error : new Error(String(error)));
            } finally { again(); }
          }, Math.max(1, seconds) * 1000);
          timer.unref();
        };
        again();
        return () => { closed = true; clearTimeout(timer); };
      },
    },
  };
  try {
    const connectorNotes = await Promise.all(chosen.map(async connector => {
      const needsKey = connector.kind === 'http' && connector.http.auth && !await keyOf(connector);
      return `Selected connector: ${connector.title}${needsKey ? ' (key missing)' : ''}.`;
    }));
    return { bindings, notes: [...connectorNotes, ...tools.notes], close: tools.close };
  } catch (error) {
    await tools.close();
    throw error;
  }
}
