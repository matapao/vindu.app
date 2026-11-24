// The app's own processors: the claude and codex CLIs on this computer, found where their installers put them or on
// PATH as the app starts, each run through Celler's harness (processor-turns.ts). A CLI not found is no processor:
// Settings says it is missing. What a found one still needs, such as its sign-in, Settings says from its health check,
// which asks the CLI its version and whether it is signed in, and calls no model.
import { AGENT_PROGRAMS, AgentRuntime, claudeAgent, codexAgent, findProgram, type AgentProgram, type Host, type Runtime, type RuntimeHealth } from '@matapao/celler/harness';
import type { Processor, ProcessorCheck } from './desktop-settings.js';
import { connectRuntime } from './processor-turns.js';
import type { TaskConnection, TaskProcessor } from './task.js';

const NAMES: Record<AgentProgram, string> = { claude: 'Claude Code', codex: 'Codex' };
/** The app, as its runs' requests name it, and the mark its runs' environments carry. */
const HOST: Host = { client: { name: 'vindu', version: '0.1.0' }, mark: env => ({ ...env, VINDU_TASK_RUN: '1' }) };

export type LocalProcessorOptions = {
  /** Codex's home for this app: its sign-in and sessions, in a folder of the app's own, never the person's own Codex home. */
  codexHome: string;
  /** Where a CLI is on this computer, or null: where its installers put it, else on PATH, by default (a test's own). */
  find?: (program: AgentProgram) => string | null;
  /** What runs a CLI: Celler's harness, through the CLI's own SDK, by default (a test's own, which calls no model). */
  runtime?: (program: AgentProgram) => Runtime;
};

/** What the person reads when a CLI is missing or signed out, in the app's words. */
function wordsFor(codexHome: string) {
  const codexLogin = `CODEX_HOME="${codexHome}" codex login`;
  return {
    claude: { noClaude: "Claude Code wasn't found on this computer. Install it, then restart Vindu.",
      login: 'Claude Code is not signed in: run claude auth login in a terminal, then send the message again.' },
    codex: { install: 'Install it, then restart Vindu.', signedOut: `not signed in for Vindu (${codexLogin}, in a terminal, signs it in)`,
      login: `Codex is not signed in for Vindu: run ${codexLogin} in a terminal, then send the message again.` },
    claudeSignedOut: 'claude auth login, in a terminal, signs it in',
  };
}

/** A health check as Settings says it: what is there, and what it still needs. */
function detailOf(program: AgentProgram, health: RuntimeHealth, claudeSignedOut: string): string {
  if (health.ok) return health.detail.replace(/ \(not yet test-run\)$/, '');
  return program === 'claude' && health.fix === 'login' ? `${health.detail} (${claudeSignedOut})` : health.detail;
}

/** The CLIs found on this computer as the app's processors, how a task connects to the one it runs on, and their
 *  checks for Settings: what `startApp` takes as `processors`, `connect` and `checkProcessors`. */
export function localProcessors(o: LocalProcessorOptions) {
  const find = o.find ?? ((program: AgentProgram) => findProgram(program));
  const words = wordsFor(o.codexHome);
  const agentOf = (program: AgentProgram) => program === 'claude'
    ? claudeAgent({ claude: () => find('claude'), words: words.claude })
    : codexAgent({ codex: () => find('codex'), home: o.codexHome, words: words.codex });
  const found = AGENT_PROGRAMS.filter(program => find(program) !== null);
  const runtimes = new Map(found.map(program => [program, o.runtime ? o.runtime(program) : new AgentRuntime(agentOf(program), HOST)]));
  const processors: Processor[] = found.map(program => ({ id: program, name: NAMES[program] }));

  /** A task's connection to the CLI it runs on; none for a processor that is not one of these. */
  const connect = (task: TaskConnection): TaskProcessor | undefined => {
    const runtime = runtimes.get(task.processor as AgentProgram);
    return runtime ? connectRuntime(task, runtime) : undefined;
  };
  /** Each CLI: a found one by its health check, a missing one by what to do about it. */
  const checkProcessors = (): Promise<ProcessorCheck[]> => Promise.all(AGENT_PROGRAMS.map(async program => {
    const runtime = runtimes.get(program);
    if (!runtime) {
      const missing = agentOf(program).find();
      return { id: program, name: NAMES[program], found: false, ready: false,
        detail: typeof missing === 'string' ? `${NAMES[program]} is on this computer now: restart Vindu to use it.` : missing.missing };
    }
    const health = await runtime.health(false);
    return { id: program, name: NAMES[program], found: true, ready: health.ok, detail: detailOf(program, health, words.claudeSignedOut) };
  }));
  return { processors, connect, checkProcessors };
}
