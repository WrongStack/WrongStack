import type { ConnectionState } from './contracts.js';
import type { MCPPrompt, MCPResource, MCPResourceTemplate, MCPServerMetadata } from './protocol.js';
import type { MCPRegistryCatalog } from './registry-types.js';

const MAX_CATALOG_PAGES = 100;
const MAX_CATALOG_ITEMS = 10_000;

export async function collectCatalogPages<Page extends { nextCursor?: string | undefined }, Item>(
  load: (cursor?: string | undefined) => Promise<Page>,
  select: (page: Page) => Item[],
): Promise<Item[]> {
  const items: Item[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_CATALOG_PAGES; pageNumber++) {
    const page = await load(cursor);
    items.push(...select(page));
    if (items.length > MAX_CATALOG_ITEMS) {
      throw new Error(`MCP catalog exceeds ${MAX_CATALOG_ITEMS} items`);
    }
    const next = page.nextCursor;
    if (!next) return items;
    if (seenCursors.has(next)) throw new Error(`MCP catalog repeated cursor "${next}"`);
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error(`MCP catalog exceeds ${MAX_CATALOG_PAGES} pages`);
}

export function cloneCatalogRecords<T>(records: T[]): T[] {
  return structuredClone(records);
}

interface CatalogSnapshotSlot {
  cfg: { name: string };
  state: ConnectionState;
  serverMetadata?: MCPServerMetadata | undefined;
  resources?: MCPResource[] | undefined;
  resourceTemplates?: MCPResourceTemplate[] | undefined;
  prompts?: MCPPrompt[] | undefined;
}

export function registryCatalogSnapshot(slot: CatalogSnapshotSlot): MCPRegistryCatalog {
  return {
    name: slot.cfg.name,
    state: slot.state,
    serverMetadata: slot.serverMetadata ? structuredClone(slot.serverMetadata) : undefined,
    resources: slot.resources ? cloneCatalogRecords(slot.resources) : undefined,
    resourceTemplates: slot.resourceTemplates
      ? cloneCatalogRecords(slot.resourceTemplates)
      : undefined,
    prompts: slot.prompts ? cloneCatalogRecords(slot.prompts) : undefined,
  };
}
