/**
 * Catalog projections used by spec-linker and public discovery APIs.
 * Plugin identity and source paths are owned by the typed manifest.
 */
import type { Plugin } from '@wrongstack/contracts/types';
import { OFFICIAL_PLUGIN_MANIFEST } from './manifest/index.js';

export interface CatalogEntry {
  name: string;
  path: string;
}

export const PLUGIN_CATALOG_ENTRIES: readonly CatalogEntry[] = Object.freeze(
  OFFICIAL_PLUGIN_MANIFEST.map((entry) =>
    Object.freeze({ name: entry.name, path: entry.sourcePath }),
  ),
);

export const PLUGIN_CATALOG: ReadonlyMap<string, string> = new Map(
  PLUGIN_CATALOG_ENTRIES.map((entry) => [entry.name, entry.path]),
);

export const PLUGIN_NAMES: readonly string[] = Object.freeze(
  PLUGIN_CATALOG_ENTRIES.map((entry) => entry.name),
);

export type { Plugin };
