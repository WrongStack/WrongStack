/**
 * The provider catalog the HQ Providers screen picks from: the same
 * models.dev registry (plus WrongStack's curated overlay) every client uses,
 * read from this machine's shared cache so HQ shows exactly the providers a
 * device will recognise.
 */
import * as path from 'node:path';
import type { ModelsRegistry } from '@wrongstack/contracts/types';
import { DefaultModelsRegistry } from '@wrongstack/core/models';
import { wstackGlobalRoot } from '@wrongstack/core/utils';
import { resolveBundledOverlayFile } from '../../boot-provider-selection.js';

const PROVIDERS_OVERLAY_URL =
  'https://raw.githubusercontent.com/WrongStack/WrongStack/main/packages/cli/data/providers.json';
/** Models listed per provider; the full list stays in the registry. */
const MAX_MODELS = 400;

export interface HqVaultCatalogProvider {
  id: string;
  name: string;
  family: string;
  apiBase?: string;
  envVars: string[];
  doc?: string;
  models: { id: string; name?: string }[];
}

export function createHqVaultModelsRegistry(globalRoot = wstackGlobalRoot()): ModelsRegistry {
  const cacheDir = path.join(globalRoot, 'cache');
  const overlayFile = resolveBundledOverlayFile();
  return new DefaultModelsRegistry({
    cacheFile: path.join(cacheDir, 'models.dev.json'),
    // A day: the catalog is a picker, not runtime metadata; a stale cache or
    // the bundled overlay still answers when the network is down.
    ttlSeconds: 86_400,
    overlayUrl: PROVIDERS_OVERLAY_URL,
    ...(overlayFile ? { overlayFile } : {}),
    overlayCacheFile: path.join(cacheDir, 'models-overlay.json'),
  });
}

export async function listHqVaultCatalog(
  registry: ModelsRegistry,
): Promise<HqVaultCatalogProvider[]> {
  const providers = await registry.listProviders();
  return providers
    .filter((p) => p.family !== 'unsupported')
    .map((p) => ({
      id: p.id,
      name: p.name,
      family: p.family,
      ...(p.apiBase ? { apiBase: p.apiBase } : {}),
      envVars: [...p.envVars],
      ...(p.doc ? { doc: p.doc } : {}),
      models: p.models.slice(0, MAX_MODELS).map((m) => ({
        id: m.id,
        ...(m.name && m.name !== m.id ? { name: m.name } : {}),
      })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
