// Links that open an app: vindu://<app>/<rest>, for any app on the grid. A Mac gives the app a link as an event of its own
// (open-url); Windows and Linux start the app with it among its arguments, or start it again, and the first one hears the
// second's arguments (second-instance). A link opens that app's window as the grid opens it, with the link in its
// address's fragment (#vindu-link=<the link, encoded>): a page that takes links reads it there, and hears the next one
// as the fragment changes (hashchange); a page that takes none is as it was, since a fragment loads nothing. A link is
// the outside's word, like any address: the app takes from it only which app it names, and the page it goes to treats
// the rest as it would anything typed.
// Only vindu:// is the app's: an app's own scheme stays with that app as it is installed.

/** The scheme the packed app declares (scripts/pack.mjs), and the only one it takes. */
export const SCHEME = 'vindu';

/** The link among a start's arguments, if one is: the first that is one of the app's links. */
export const linkIn = (argv: readonly string[]) => argv.find(a => a.toLowerCase().startsWith(`${SCHEME}:`));

/** The app a link names: the id the grid knows it by (its host), or none for a link that is not one of the app's. */
export function appOf(link: string): string | undefined {
  if (link.length > 8192) return undefined; // a link, not a load
  let u: URL; try { u = new URL(link); } catch { return undefined; }
  return u.protocol === `${SCHEME}:` && /^[\w-]+$/.test(u.hostname) ? u.hostname : undefined;
}

/** An app's address with a link in its fragment: whatever fragment it had gives way. */
export const withLink = (address: string, link: string) => `${address.replace(/#.*$/s, '')}#vindu-link=${encodeURIComponent(link)}`;
