import { desktop } from '../desktop-client.js';
import type { Picked } from './desktop-api.js';
import { errorMessage } from './dom.js';
import type { Task } from './task-state.js';
import type { TaskThread } from './task-thread.js';

const STOPPED: Record<string, string> = {
  cancelled: 'Stopped',
  max_tokens: 'Stopped: the reply reached its length limit',
  max_turn_requests: 'Stopped: the turn reached its step limit',
  refusal: 'The model declined to go on',
};

export function createTaskTurns(
  selectedServers: () => string[],
  thread: TaskThread,
  refresh: (task: Task) => void,
) {
  const windowId = Math.random().toString(36).slice(2); // correlates the local optimistic message with its broadcast
  async function turn(task: Task, text: string, files: Picked[], showUserMessage = true) {
    if (showUserMessage) thread.appendUserMessage(task, text, files);
    task.localTurn = true;
    task.status = 'working';
    task.doing = '';
    task.at = Date.now();
    refresh(task);
    try {
      const r = await desktop.prompt(
        task.id,
        text,
        selectedServers(),
        files.map((f) => f.id),
        windowId,
      );
      task.status = r.stopReason === 'end_turn' ? 'idle' : 'stopped';
      for (const s of r.saved ?? []) thread.appendNote(task, s);
      if (task.status === 'stopped') {
        task.doing = STOPPED[r.stopReason] ?? `Stopped: ${r.stopReason}`;
        thread.appendNote(task, task.doing);
      }
    } catch (err) {
      task.status = 'failed';
      task.doing = errorMessage(err);
      thread.appendNote(task, task.doing, true);
    }
    task.localTurn = false;
    task.at = Date.now();
    refresh(task);
    if (task.wake) {
      task.wake = false;
      void sendPending(task);
    }
  }
  /** The person sent something from a page in the window: a turn hears it, now if none is running, or else after this
   *  one, unless the model heard it already. The thread says what was sent and from where, as the person's own words. */
  const WOKE = 'The person sent what is above from a page in the window.';
  async function sendPending(task: Task) {
    const list = await desktop.unheard(task.id).catch(() => []);
    if (!list.length || !task.live || task.status === 'starting' || task.status === 'working') return;
    const said = (v: unknown) => {
      const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? '');
      return s.length > 200 ? `${s.slice(0, 199)}…` : s;
    };
    for (const x of list)
      thread.appendUserMessage(task, `From “${task.titles.get(x.view) ?? x.view}”: ${said(x.sent)}`, []);
    await turn(task, WOKE, [], false);
  }

  return { windowId, send: turn, sendPending };
}
