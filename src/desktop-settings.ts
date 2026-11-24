import path from 'node:path';
import type { Browser } from 'playwright-core';
import type { AppsSwitch } from '@matapao/vindu/server';
import type { ServerSpec } from './connectors.js';
import type { TaskSetup } from './task.js';
import type { FrameLink } from './frame-link.js';
import type { Secrets } from './secrets.js';

/** The app's settings, kept by the person in its folder (settings.json): their MCP servers, MCP Apps' switch, and the
 *  terminals': whether the model may run commands in one they share (each after their yes), and their shell. */
export type Settings = { servers?: ServerSpec[]; apps?: AppsSwitch; appsNetwork?: boolean; terminal?: { run?: boolean; shell?: string; login?: boolean };
  person?: { name?: string };                  // who answers in this app's windows: kept with each answer, for what needs n people
  device?: { clipboard?: boolean; info?: boolean }; // the device's own data the model may ask for, each after the person's yes: off unless turned on here
  phone?: { lan?: boolean; port?: number };    // the phone window: this machine only, unless lan is true (the local network)
  holidays?: string[];                         // days that are not working days (YYYY-MM-DD), for dates and reminders in working days
  jobs?: { on?: boolean; perDay?: number };   // jobs from views' hooks: off unless on; each at most perDay runs a day (3)
  tasksFolder?: string;                       // where a task gets a folder of its own when the person picks none (~/Vindu)
};
type Processor = { id: string; name: string };
/** Desktop: the app itself, and the owner of its tasks in Celler. */
export const APP = { id: 'desktop', name: 'Vindu' };
export type AppOptions = {
  pickFolder?: () => Promise<string | null>;                  // the task's working folder: the person picks it, by default
  pickSave?: (name: string) => Promise<string | null>;         // where an export goes: the person picks it, by default
  processors?: Processor[];                                    // the harnesses its tasks may run on, as Processors in Settings lists them: none, by default
  connect?: TaskSetup['connect'];                              // each task's connection to its processor: without one, a task shows views and takes no prompt
  userData?: string;                                           // settings and tasks: the system's place for the app's data, by default
  home?: string;                                               // the person's home, for ~ in paths
  port?: number;                                               // Desktop's port (7300); the keys page's is the next one
  browserArgs?: string[];                                      // what the pages' Chromium starts with besides its own (a test's host rules)
  secrets?: Secrets;                                           // where connector keys are kept: the system's own store, by default (a test's own)
  frame?: FrameLink;                                           // the desktop app's link, when it started this core: browser views' pages live there, over their panes
  tailscale?: string | null;                                   // Tailscale's command line: where its installers put it, by default (a test's own; null: none)
  push?: { fetch?: typeof fetch; allowed?: (endpoint: string) => boolean }; // where notifications to devices go: the push services, by default (a test's own)
  lan?: boolean;                                               // on the person's own Wi-Fi until they say otherwise (a Pi's core: VINDU_LAN=on); off, by default
  lanAddresses?: () => string[];                               // this computer's addresses there: its network interfaces', by default (a test's own)
  lanName?: string;                                            // its name there: its hostname, as .local, by default (a test's own)
  pageBrowser?: () => Promise<Browser>;                        // the browser Vindu checks pages in: Playwright's Chromium, by default (a test's own)
};
/** Where Desktop's pages are, and their scripts once built. */
export const STATIC = path.join(import.meta.dirname, '..', '..', 'static'), BUILT = import.meta.dirname;
/** Desktop's icon: on its tab, and on its window when the person installs it as a web app. */
export const ICON = path.join(STATIC, 'icons', 'desktop.svg');
