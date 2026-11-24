import type { ShellCommand, ShellState } from '@matapao/vindu/renderer';
import type { PageInput, PageState } from '@matapao/vindu/renderer/browser';
import type { Shown } from '@matapao/vindu/server';
import type { Entry } from '../activity.js';
import type { ProcessorCheck } from '../desktop-settings.js';
import type { ThreadItem } from '../task-checkpoint.js';
import type { Switch } from '../task.js';
import type { Act } from '../work.js';

export type Off = () => void;
type Box = { x: number; y: number; w: number; h: number };
type TermInfo = { id: string; title: string; shared: boolean; running: boolean };
export type Mode = { kind: 'static'; template: string } | { kind: 'dynamic' };
export type TemplateFile = { file: string; name: string; about?: string; problem?: string };
export type Capture = {
  id: string;
  task: string;
  slot: string;
  kind: string;
  min?: number;
  max?: number;
  about?: string;
};
export type Pointed = Record<string, unknown> & { view: string };
export type Arranged = { entries: Entry[]; next?: Entry };
export type Connector = {
  name: string;
  title: string;
  kind: 'http' | 'mcp';
  guide: boolean;
  key?: 'set' | 'missing';
};
export type Opened = {
  id: string;
  cwd: string;
  where: string;
  notes: string[];
  switches: Switch[];
  mode: Mode;
};
export type Picked = { id: string; name: string; mime: string }; // a file the person attached: the main process keeps its path
/** Desktop's day, as Celler counts it: its limits (0: none) and what it spent today. */
export type Budget = { limits: { tokens: number; cost: number; minutes: number }; spent: { tokens: number; cost: number; minutes: number; currency?: string }; over?: string };
export type PairingCode = { code: string; until: number; owner?: boolean };
/** Phone, on this computer: Tailscale's step, whether the core is served there, a code to pair with, the devices paired. */
export type PhoneState = { step: 'install' | 'signin' | 'https' | 'ready'; host: string | null; serving: boolean; address: string | null; code: PairingCode | null;
  devices: { id: string; name: string; paired: string; seen?: string; push: boolean; owner?: boolean }[]; lan?: { on: boolean; address: string | null } };
export interface DesktopApi {
  servers(): Promise<string[]>;
  keys(): Promise<void>;
  reminders(task: string): Promise<void>;
  folder(): Promise<{ root: string }>;
  pickFolder(): Promise<string | null>;
  pickFiles(): Promise<Picked[]>;
  processors(): Promise<{ id: string; name: string }[]>;
  onProcessors(cb: (list: { id: string; name: string }[]) => void): Off;
  onAppNote(cb: (note: string) => void): Off;
  connectors(): Promise<{ list: Connector[]; failed: Record<string, string> }>;
  templates(): Promise<TemplateFile[]>;
  create(t: {
    id: string;
    harness: string;
    folder: string | null;
    title: string;
    servers: string[];
    connectors?: string[];
    template?: string;
  }): Promise<Opened>;
  branch(task: string): Promise<Opened>; // a new task from this task's view
  prompt(
    id: string,
    text: string,
    servers: string[],
    files: string[],
    origin?: string,
  ): Promise<{ stopReason: string; saved: string[]; refusals: string[] }>;
  set(id: string, sw: string, value: string | boolean): Promise<Switch[]>;
  cancel(id: string): Promise<void>;
  reveal(id: string): Promise<void>;
  close(id: string): Promise<void>;
  unheard(id: string): Promise<{ id: string; view: string; panel: string; sent: unknown }[]>;
  mode(task: string): Promise<Mode>;
  pin(task: string, name: string): Promise<{ file: string; notes: string[]; templates: TemplateFile[] }>;
  arrangement(task: string): Promise<{ file: string; templates: TemplateFile[] } | null>;
  letModelChange(task: string): Promise<boolean>;
  selection(task: string): Promise<Pointed[]>;
  exportTask(task: string): Promise<{ file: string; files: number; bytes: number } | null>;
  captureFile(id: string): Promise<string[]>;
  captureSkip(id: string): Promise<void>;
  onCaptures(cb: (list: Capture[]) => void): Off;
  phone(): Promise<{ url: string; lan: boolean } | null>;
  // Settings: where this page is, Processors and the day's budget, and Phone
  settingsState(): Promise<{ host: string; device: string | null; away: boolean; setsUp: boolean }>;
  settingsProcessors(): Promise<{ processors: { id: string; name: string }[]; granted: string[]; connectors: { name: string; title: string }[] }>;
  settingsGrant(processor: string, on: boolean): Promise<string[]>;
  settingsProcessorChecks(): Promise<ProcessorCheck[]>;
  settingsBudget(): Promise<Budget>;
  settingsSetBudget(limits: Budget['limits']): Promise<Budget>;
  settingsPhone(): Promise<PhoneState>;
  settingsPhoneServe(on: boolean): Promise<{ ok: boolean; said?: string; link?: string; state: PhoneState }>;
  settingsPhoneCode(q: { owner: boolean }): Promise<PairingCode>;
  settingsPhoneRemove(id: string): Promise<PhoneState['devices']>;
  settingsDevice(): Promise<{ name: string; push: boolean; key: string } | null>;
  settingsPush(sub: PushSubscriptionJSON | null): Promise<boolean>;
  restoreActivity(): Promise<{
    activity: Arranged;
    unavailable: string[];
    tasks: {
      id: string;
      thread: ThreadItem[];
      views: Shown[];
      state?: ShellState;
      switches: Switch[];
      mode: Mode;
      where: string;
    }[];
  }>;
  onUser(cb: (id: string, item: Extract<ThreadItem, { kind: 'user' }>, origin?: string) => void): Off;
  activity(): Promise<Arranged>;
  pinTask(task: string, on: boolean): Promise<void>;
  muteTask(task: string, on: boolean): Promise<void>;
  onActivity(cb: (a: Arranged) => void): Off;
  onFront(cb: (task: string) => void): Off;
  onMenu(cb: (what: string) => void): Off;
  shown(task: string): void;
  event(id: string, e: unknown): void;
  onView(cb: (id: string, v: Shown) => void): Off;
  onShell(cb: (id: string, s: ShellState) => void): Off;
  onText(cb: (id: string, text: string) => void): Off;
  onNote(cb: (id: string, note: string) => void): Off;
  onSwitches(cb: (id: string, s: Switch[]) => void): Off;
  onAct(cb: (id: string, a: Act) => void): Off;
  onAskGone(cb: (id: string, view: string, action: string) => void): Off;
  onApp(cb: (id: string, view: string, panel: string, msg: unknown) => void): Off;
  onSuggest(cb: (id: string, text: string) => void): Off;
  onSent(cb: (id: string, view: string) => void): Off;
  onTold(cb: (id: string, said: string) => void): Off;
  onCommand(cb: (c: ShellCommand) => void): Off;
  onFiles(cb: (files: Picked[]) => void): void;
  viewEnd(task: string, name: string): Promise<void>;
  viewShare(task: string, name: string, on: boolean): Promise<boolean>;
  viewBox(task: string, name: string, box: Box | null): void;
  ptyNew(task: string, cols?: number, rows?: number): Promise<TermInfo>;
  ptyAttach(task: string, term: string): Promise<TermInfo>;
  ptyDetach(task: string, term: string): void;
  ptyInput(task: string, term: string, data: string): void;
  ptyResize(task: string, term: string, cols: number, rows: number): void;
  onPty(cb: (task: string, term: string, data: string) => void): Off;
  onPtyExit(cb: (task: string, term: string, code: number) => void): Off;
  browserNew(task: string, url?: string): Promise<string>;
  browserState(task: string, name: string): Promise<PageState>;
  browserNavigate(task: string, name: string, url: string): Promise<PageState>;
  browserGo(task: string, name: string, to: 'back' | 'forward' | 'reload'): Promise<PageState>;
  onBrowser(cb: (task: string, name: string, s: PageState) => void): Off;
  browserInput(task: string, name: string, e: PageInput): void;
  onFrame(cb: (task: string, name: string, f: { data: string; width: number; height: number }) => void): Off;
  browserPoint(task: string, name: string): Promise<unknown>;
  browserStopPointing(task: string, name: string): Promise<void>;
}
