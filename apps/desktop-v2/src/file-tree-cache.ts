/**
 * The last project listing this window read, per project, folder scope and ignore filter, with
 * the `files.tree.changed` event that was current when it was read.
 *
 * A listing is the whole project tree in one reply (about 2 MB and 16k entries for this
 * repository), and the Files view asked for it each time it opened. Every reply also lands in
 * the project journal. While no change event has arrived since, the listing read last is
 * still the project's tree, so opening Files again uses it; file actions and change events
 * read a fresh one as before.
 */
interface Listing {
  tree: unknown;
  /** The change event the listing was current at (compared by identity). */
  marker: unknown;
  at: number;
}

/** How long a listing stands in for a read, as a bound for changes the watcher missed. */
const TREE_LISTING_TTL_MS = 10 * 60_000;
/** Listings kept, most recently read last. */
const LISTING_LIMIT = 6;
const listings = new Map<string, Listing>();

export function treeListingKey(projectId: string, scope: string, includeIgnored: boolean) {
  return `${projectId}\0${scope}\0${includeIgnored ? 'all' : 'visible'}`;
}

/** Keeps `tree`, read while `marker` was the latest change event. */
export function rememberTreeListing(key: string, tree: unknown, marker: unknown, now = Date.now()) {
  listings.delete(key);
  listings.set(key, { tree, marker, at: now });
  for (const old of [...listings.keys()].slice(0, Math.max(0, listings.size - LISTING_LIMIT)))
    listings.delete(old);
}

/** The listing to show instead of reading one, or undefined when it may be out of date. */
export function currentTreeListing(key: string, marker: unknown, now = Date.now()): unknown {
  const listing = listings.get(key);
  if (!listing || listing.marker !== marker || now - listing.at > TREE_LISTING_TTL_MS)
    return undefined;
  return listing.tree;
}
