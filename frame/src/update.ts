// The app's updates: a newer release, from a feed of its releases (electron-builder's generic one: a folder on a web
// server with latest-mac.yml, latest.yml or latest-linux.yml, and the builds they name). The feed's address comes from
// configuration: VINDU_UPDATES as the app is packed (scripts/pack.mjs writes it into the app, as app-update.yml), or as
// it starts, which goes first. With neither there is no feed: no release host is chosen yet. Only the app as installed
// looks, never a build being worked on, and it only looks: a newer release is said in the menu bar, and fetched and
// installed when the person picks it there, as the app restarts, with the server that comes inside it.
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import electronUpdater from 'electron-updater';

export type Updates = { install(): void };

/** The feed watched: at the start, then every six hours. onNewer: a release newer than this one is out (its version). */
export function watchUpdates(o: { onNewer: (version: string) => void }): Updates | undefined {
  const feed = process.env.VINDU_UPDATES;
  if (!app.isPackaged || (!feed && !fs.existsSync(path.join(process.resourcesPath, 'app-update.yml')))) return undefined;
  const { autoUpdater } = electronUpdater;
  autoUpdater.logger = null; autoUpdater.autoDownload = false; autoUpdater.autoInstallOnAppQuit = false; // nothing fetched, nothing installed, unasked
  if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed }); // as packed (scripts/pack.mjs)
  autoUpdater.on('update-available', (u: { version: string }) => { console.log(`vindu: ${u.version} is out (this is ${app.getVersion()})`); o.onNewer(u.version); });
  autoUpdater.on('error', (e: Error) => console.error(`vindu: no update (${e.message.split('\n')[0]})`));
  const look = () => void autoUpdater.checkForUpdates().catch(() => undefined); // its error is said above
  look(); setInterval(look, 6 * 3600_000).unref();
  return { install: () => void autoUpdater.downloadUpdate().then(() => autoUpdater.quitAndInstall()).catch(() => undefined) };
}
