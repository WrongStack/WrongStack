// Vendored from WrongMemory (https://github.com/WrongStack/wrongmemory) commit d78559e,
// file packages/client-ts/src/discovery.ts. Do not edit here; update upstream and re-vendor.
/**
 * Data-root resolution and discovery files, matching
 * `crates/wrongmemory-ipc/src/endpoint.rs`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { EndpointInfo } from './contracts.js';
import { WrongMemoryError } from './errors.js';

export const DATA_ROOT_ENV = 'WRONGMEMORY_HOME';

/** Explicit root, else `WRONGMEMORY_HOME`, else `~/.wrongmemory`. */
export function resolveDataRoot(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const env = process.env[DATA_ROOT_ENV];
  if (env) return resolve(env);
  return resolve(join(homedir(), '.wrongmemory'));
}

export const paths = (root: string) => ({
  endpointFile: join(root, 'runtime', 'endpoint.json'),
  tokenFile: join(root, 'runtime', 'token'),
  grantsDir: join(root, 'grants'),
});

export interface Discovery {
  info: EndpointInfo;
  token: string;
}

export function loadDiscovery(root: string): Discovery {
  const p = paths(root);
  if (!existsSync(p.endpointFile)) {
    throw new WrongMemoryError('UNAVAILABLE', `no discovery metadata in ${root}`);
  }
  try {
    const info = JSON.parse(readFileSync(p.endpointFile, 'utf8')) as EndpointInfo;
    const token = readFileSync(p.tokenFile, 'utf8').trim();
    return { info, token };
  } catch (e) {
    throw new WrongMemoryError('UNAVAILABLE', `cannot read discovery metadata: ${(e as Error).message}`);
  }
}

export function grantSecretFile(root: string, grantId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(grantId)) {
    throw new WrongMemoryError('INVALID_REQUEST', 'grant id must be [A-Za-z0-9_-]+');
  }
  return join(paths(root).grantsDir, `${grantId}.secret`);
}

export function readGrantSecret(root: string, grantId: string): string {
  const file = grantSecretFile(root, grantId);
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (e) {
    throw new WrongMemoryError(
      'UNAVAILABLE',
      `cannot read credential for grant ${grantId}: ${(e as Error).message}`,
    );
  }
}
