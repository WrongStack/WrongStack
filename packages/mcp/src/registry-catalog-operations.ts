import {
  type MCPInsertionPolicy,
  type MCPPromptInsertion,
  type MCPResourceInsertion,
  preparePromptInsertion,
  prepareResourceInsertion,
} from './content-selection.js';
import type {
  MCPGetPromptResult,
  MCPPrompt,
  MCPReadResourceResult,
  MCPResource,
  MCPResourceTemplate,
} from './protocol.js';
import {
  advanceCatalogVersion,
  cloneCatalogRecords,
  collectCatalogPages,
  registryCatalogSnapshot,
} from './registry-catalog.js';
import type { MCPRegistryCatalog } from './registry-types.js';

export interface RegistryCatalogOperationsHost {
  servers: Map<string, import('./registry-slots.js').ServerSlot>;
  disabledServers: Map<string, import('@wrongstack/contracts/types').MCPServerConfig>;
  requireSlot: (name: string) => import('./registry-slots.js').ServerSlot;
  withConnectedClient: <T>(
    name: string,
    run: (client: import('./client.js').MCPClient, assertCurrent: () => void) => Promise<T>,
  ) => Promise<T>;
  persistCapabilityManifest: (slot: import('./registry-slots.js').ServerSlot) => Promise<void>;
  readResource: (
    name: string,
    uri: string,
  ) => Promise<import('./protocol.js').MCPReadResourceResult>;
  getPrompt: (
    serverName: string,
    promptName: string,
    args?: Record<string, string> | undefined,
  ) => Promise<import('./protocol.js').MCPGetPromptResult>;
}

export function getCatalog(
  this: RegistryCatalogOperationsHost,
  name: string,
): MCPRegistryCatalog | undefined {
  const slot = this.servers.get(name);
  if (slot) {
    return registryCatalogSnapshot(slot);
  }
  const disabled = this.disabledServers.get(name);
  if (disabled) {
    return {
      name: disabled.name,
      state: 'idle',
    };
  }
  return undefined;
}

export async function listResources(
  this: RegistryCatalogOperationsHost,
  name: string,
  opts: { refresh?: boolean } = {},
): Promise<MCPResource[]> {
  const slot = this.requireSlot(name);
  if (!opts.refresh && slot.resources) return cloneCatalogRecords(slot.resources);
  const version = advanceCatalogVersion(slot, 'resources');
  return this.withConnectedClient(name, async (client, assertCurrent) => {
    if (!client.getServerMetadata()?.capabilities.resources) return [];
    const resources = await collectCatalogPages(
      (cursor) => client.listResources(cursor ? { cursor } : {}),
      (page) => page.resources,
    );
    assertCurrent();
    if (slot.catalogVersions?.resources === version) {
      slot.resources = resources;
      await this.persistCapabilityManifest(slot);
    }
    return cloneCatalogRecords(resources);
  });
}

export async function listResourceTemplates(
  this: RegistryCatalogOperationsHost,
  name: string,
  opts: { refresh?: boolean } = {},
): Promise<MCPResourceTemplate[]> {
  const slot = this.requireSlot(name);
  if (!opts.refresh && slot.resourceTemplates) return cloneCatalogRecords(slot.resourceTemplates);
  const version = advanceCatalogVersion(slot, 'resourceTemplates');
  return this.withConnectedClient(name, async (client, assertCurrent) => {
    if (!client.getServerMetadata()?.capabilities.resources) return [];
    const templates = await collectCatalogPages(
      (cursor) => client.listResourceTemplates(cursor ? { cursor } : {}),
      (page) => page.resourceTemplates,
    );
    assertCurrent();
    if (slot.catalogVersions?.resourceTemplates === version) {
      slot.resourceTemplates = templates;
      await this.persistCapabilityManifest(slot);
    }
    return cloneCatalogRecords(templates);
  });
}

export async function readResource(
  this: RegistryCatalogOperationsHost,
  name: string,
  uri: string,
): Promise<MCPReadResourceResult> {
  return this.withConnectedClient(name, (client) => client.readResource(uri));
}

export async function selectResourceForInsertion(
  this: RegistryCatalogOperationsHost,
  name: string,
  uri: string,
  policy?: MCPInsertionPolicy | undefined,
): Promise<MCPResourceInsertion> {
  return prepareResourceInsertion(name, uri, await this.readResource(name, uri), policy);
}

export async function subscribeResource(
  this: RegistryCatalogOperationsHost,
  name: string,
  uri: string,
): Promise<void> {
  await this.withConnectedClient(name, (client) => client.subscribeResource(uri));
}

export async function unsubscribeResource(
  this: RegistryCatalogOperationsHost,
  name: string,
  uri: string,
): Promise<void> {
  await this.withConnectedClient(name, (client) => client.unsubscribeResource(uri));
}

export async function listPrompts(
  this: RegistryCatalogOperationsHost,
  name: string,
  opts: { refresh?: boolean } = {},
): Promise<MCPPrompt[]> {
  const slot = this.requireSlot(name);
  if (!opts.refresh && slot.prompts) return cloneCatalogRecords(slot.prompts);
  const version = advanceCatalogVersion(slot, 'prompts');
  return this.withConnectedClient(name, async (client, assertCurrent) => {
    if (!client.getServerMetadata()?.capabilities.prompts) return [];
    const prompts = await collectCatalogPages(
      (cursor) => client.listPrompts(cursor ? { cursor } : {}),
      (page) => page.prompts,
    );
    assertCurrent();
    if (slot.catalogVersions?.prompts === version) {
      slot.prompts = prompts;
      await this.persistCapabilityManifest(slot);
    }
    return cloneCatalogRecords(prompts);
  });
}

export async function getPrompt(
  this: RegistryCatalogOperationsHost,
  serverName: string,
  promptName: string,
  args?: Record<string, string> | undefined,
): Promise<MCPGetPromptResult> {
  return this.withConnectedClient(serverName, (client) => client.getPrompt(promptName, args));
}

export async function selectPromptForInsertion(
  this: RegistryCatalogOperationsHost,
  serverName: string,
  promptName: string,
  args?: Record<string, string> | undefined,
  policy?: MCPInsertionPolicy | undefined,
): Promise<MCPPromptInsertion> {
  return preparePromptInsertion(
    serverName,
    promptName,
    args,
    await this.getPrompt(serverName, promptName, args),
    policy,
  );
}

/**
 * Body of `MCPRegistry.withConnectedClient()`: keep all remote requests awake
 * and reject results from superseded clients.
 */
export async function runWithConnectedClient<T>(
  self: Pick<RegistryCatalogOperationsHost, 'servers' | 'requireSlot'> & {
    ensureConnected(name: string): Promise<import('./client.js').MCPClient>;
  },
  name: string,
  run: (client: import('./client.js').MCPClient, assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  const slot = self.requireSlot(name);
  const generation = slot.startupGeneration;
  slot.operations.inFlightCalls++;
  slot.operations.peakInFlightCalls = Math.max(
    slot.operations.peakInFlightCalls,
    slot.operations.inFlightCalls,
  );
  try {
    const client = await self.ensureConnected(name);
    const assertCurrent = () => {
      if (
        self.servers.get(name) !== slot ||
        slot.startupGeneration !== generation ||
        slot.client !== client ||
        slot.state !== 'connected'
      ) {
        throw new Error(`MCP server "${name}" connection changed during request`);
      }
    };
    assertCurrent();
    const result = await run(client, assertCurrent);
    assertCurrent();
    return result;
  } finally {
    slot.operations.inFlightCalls = Math.max(0, slot.operations.inFlightCalls - 1);
    if (slot.startupGeneration === generation) slot.lastUsed = Date.now();
  }
}
