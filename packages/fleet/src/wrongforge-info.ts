/**
 * What the machine's WrongForge serves (`GET /v1/info`): its models, its
 * default model and the optional submit features it understands.
 *
 * The model list is WrongForge's own word, never a list kept here. It is
 * cached on disk so the `delegate` description — built once at boot, without
 * waiting on the network — can name the models; every task and every boot
 * refresh the cache.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { wstackGlobalRoot } from '@wrongstack/core/utils';

/**
 * Where WrongForge answers. Structural, so this module stays a leaf:
 * wrongforge-client.ts imports from here, never the other way round.
 */
interface WrongForgeEndpoint {
  url: string;
  apiKey: string;
}

export interface WrongForgeInfo {
  models: string[];
  defaultModel?: string | undefined;
  features: string[];
  effortLevels?: string[] | undefined;
  modelDetails?: { id: string; description: string; effortLevels: string[] }[] | undefined;
}

function wrongForgeInfoCacheFile(): string {
  return path.join(wstackGlobalRoot(), 'cache', 'wrongforge-info.json');
}

/** Normalises a `/v1/info` body; anything malformed reads as "nothing known". */
export function parseWrongForgeInfo(body: unknown): WrongForgeInfo {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  const def = o['default_model'] ?? o['defaultModel'];
  const details = o['model_details'] ?? o['modelDetails'];
  const effort = o['effort'] as { levels?: unknown } | undefined;
  const levels = effort?.levels ?? o['effortLevels'];
  return {
    models: strings(o['models']),
    ...(typeof def === 'string' && def ? { defaultModel: def } : {}),
    features: strings(o['features']),
    ...(Array.isArray(levels) ? { effortLevels: strings(levels) } : {}),
    ...(Array.isArray(details)
      ? {
          modelDetails: details.flatMap((value: unknown) => {
            if (!value || typeof value !== 'object') return [];
            const d = value as Record<string, unknown>;
            if (typeof d['id'] !== 'string' || !d['id']) return [];
            return [
              {
                id: d['id'],
                description: typeof d['description'] === 'string' ? d['description'] : '',
                effortLevels: strings(d['effort_levels'] ?? d['effortLevels']),
              },
            ];
          }),
        }
      : {}),
  };
}

export function readCachedWrongForgeInfo(
  file = wrongForgeInfoCacheFile(),
): WrongForgeInfo | undefined {
  try {
    const info = parseWrongForgeInfo(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
    return info.models.length > 0 ? info : undefined;
  } catch {
    return undefined;
  }
}

export function writeWrongForgeInfoCache(
  info: WrongForgeInfo,
  file = wrongForgeInfoCacheFile(),
): void {
  if (info.models.length === 0) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(info)}\n`);
    renameSync(tmp, file);
  } catch {
    // A cache: losing a write only means the next boot names fewer models.
  }
}

async function fetchWrongForgeInfo(
  ep: WrongForgeEndpoint,
  opts: { fetchImpl?: typeof fetch | undefined; signal?: AbortSignal | undefined } = {},
): Promise<WrongForgeInfo> {
  const res = await (opts.fetchImpl ?? fetch)(`${ep.url}/v1/info`, {
    headers: { authorization: `Bearer ${ep.apiKey}` },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) throw new Error(`WrongForge /v1/info answered ${res.status}`);
  return parseWrongForgeInfo(await res.json());
}

/** Boot-time, fire-and-forget: refresh the cache for the next description. */
export function refreshWrongForgeInfoCache(ep: WrongForgeEndpoint | undefined): void {
  if (!ep) return;
  void fetchWrongForgeInfo(ep, { signal: AbortSignal.timeout(3_000) })
    .then((info) => writeWrongForgeInfoCache(info))
    .catch(() => undefined);
}
