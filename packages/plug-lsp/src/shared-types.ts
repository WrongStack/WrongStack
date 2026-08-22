/**
 * Narrow cross-module surfaces shared by `registry.ts` and `document-tracker.ts`.
 *
 * LSPRegistry and DocumentTracker reference each other only through these two
 * members: the registry reopens tracked documents for a server, and the tracker
 * enumerates the registry's servers. Declaring those surfaces here as
 * type-only interfaces lets both classes depend on this leaf instead of on each
 * other, breaking the type-level SCC ARCH-CYCLE-TYPE-18
 * (registry.ts ↔ document-tracker.ts) without moving either class body.
 *
 * This module MUST contain no runtime imports.
 */

import type { LSPServer } from './server/lsp-server.js';

/** Tracker surface used by LSPRegistry: reopen tracked docs for a server. */
export interface ReopenableTracker {
  reopenForServer(server: LSPServer): Promise<void>;
}

/** Registry surface used by DocumentTracker: enumerate live servers. */
export interface ServerLister {
  list(): readonly LSPServer[];
}
