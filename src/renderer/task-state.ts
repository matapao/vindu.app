import type { ShellHandle, ShellState } from '@matapao/vindu/renderer';
import type { Ask } from '@matapao/vindu/server';
import type { Switch } from '../task.js';
import type { Mode, Picked } from './desktop-api.js';

type Status = 'starting' | 'working' | 'idle' | 'stopped' | 'failed';
export type Pending = { ask: Ask; box: HTMLElement; picked?: string };
export type Task = {
  id: string;
  title: string;
  harness: string;
  status: Status;
  localTurn?: boolean;
  doing: string;
  last: string;
  at: number;
  live: boolean;
  where?: string;
  switches: Switch[];
  asks: Map<string, Pending>;
  calls: Map<string, HTMLDetailsElement>;
  plan?: HTMLElement;
  card: HTMLElement;
  turns: HTMLElement;
  reply?: { box: HTMLElement; text: string };
  views?: { el: HTMLElement; shell: ShellHandle };
  draft: string;
  files: Picked[];
  titles: Map<string, string>;
  wake?: boolean; // its views' titles; something sent from a page while a turn ran
  mode?: Mode;
  state?: ShellState;
  pointedAt?: string; // static or dynamic; the shell's state; what was pointed at, as last drawn
  listed?: boolean; // the main process has listed it: once it is no longer listed, it has closed
  seen?: number; // at a phone's width, how many views it had when the person last looked at them
};
