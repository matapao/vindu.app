// Links that open Desktop: vindu://desktop/<rest>. A Mac gives the app a link as an event of its own (open-url); Windows
// and Linux start the app with it among its arguments, or start it again, and the first one hears the second's
// arguments (second-instance). A link opens Desktop's window with the link in its address's fragment (#vindu-link=<the
// link, encoded>): the page reads it there, and hears the next one as the fragment changes (hashchange), since a
// fragment loads nothing. A link is the outside's word, like any address: the app takes from it only which window it
// names (desktop, or add-core for the window that adds a core elsewhere), and the page treats the rest as it would
// anything typed.
// vindu:// is the only scheme the app takes.

/** The scheme the packed app declares (scripts/pack.mjs), and the only one it takes. */
export const SCHEME = 'vindu';

/** The link among a start's arguments, if one is: the first that is one of the app's links. */
export const linkIn = (argv: readonly string[]) => argv.find(a => a.toLowerCase().startsWith(`${SCHEME}:`));

/** The window a link names (its host: desktop or add-core), or none for a link that is not one of the app's. */
export function windowOf(link: string): string | undefined {
  if (link.length > 8192) return undefined; // a link, not a load
  let u: URL; try { u = new URL(link); } catch { return undefined; }
  return u.protocol === `${SCHEME}:` && /^[\w-]+$/.test(u.hostname) ? u.hostname : undefined;
}

/** A Desktop's address with a link in its fragment: whatever fragment it had gives way. */
export const withLink = (address: string, link: string) => `${address.replace(/#.*$/s, '')}#vindu-link=${encodeURIComponent(link)}`;
