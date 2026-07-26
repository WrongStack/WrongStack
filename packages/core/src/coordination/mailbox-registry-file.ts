import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import {
  parseAgentRegistryEntry,
  parseClientRegistryEntry,
} from './mailbox-registry-codec.js';
import type { RegisteredAgent, RegisteredClient } from './mailbox-types.js';

export async function readAgentRegistryFile(
  registryPath: string,
): Promise<Map<string, RegisteredAgent>> {
  return readRegistryFile(registryPath, parseAgentRegistryEntry, 'agent');
}

export async function readClientRegistryFile(
  registryPath: string,
): Promise<Map<string, RegisteredClient>> {
  return readRegistryFile(registryPath, parseClientRegistryEntry, 'client');
}

export async function writeRegistryFile<T>(registryPath: string, registry: Map<string, T>): Promise<void> {
  const obj: Record<string, T> = {};
  for (const [id, value] of registry) {
    obj[id] = value;
  }
  const tmp = `${registryPath}.${randomUUID().slice(0, 8)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(obj), 'utf8');
  await fsp.rename(tmp, registryPath);
}

async function readRegistryFile<T>(
  registryPath: string,
  parseEntry: (value: unknown) => T | null,
  kind: 'agent' | 'client',
): Promise<Map<string, T>> {
  try {
    const raw = await fsp.readFile(registryPath, 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    const map = new Map<string, T>();
    for (const [id, value] of Object.entries(data)) {
      const parsed = parseEntry(value);
      if (parsed) {
        map.set(id, parsed);
      } else {
        warnInvalidRegistryEntry(kind, id);
      }
    }
    return map;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Map<string, T>();
    }
    throw err;
  }
}

function warnInvalidRegistryEntry(kind: 'agent' | 'client', id: string): void {
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: kind === 'agent' ? 'mailbox.registry.invalid_agent' : 'mailbox.registry.invalid_client',
      message: `Skipping malformed ${kind} entry "${id}" in ${kind === 'agent' ? 'registry' : 'client registry'}`,
      timestamp: new Date().toISOString(),
    }),
  );
}
