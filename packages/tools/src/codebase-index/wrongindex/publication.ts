import { AsyncLocalStorage } from 'node:async_hooks';
import { WrongIndexRemoteError } from './client.js';

export interface WrongIndexPublication {
  projectRoot: string;
  indexDir: string;
  projectId: string;
  daemonInstanceId: string;
  generation: number;
  graphStamp?: string | null | undefined;
  observedAt: number;
  indexing?: boolean;
  freshness?: string;
  lastError?: string | null | undefined;
  publicationPending?: boolean;
  indexCorrupt?: unknown;
}
const metadata = new WeakMap<object, WrongIndexPublication>();
const listeners = new Set<(publication: WrongIndexPublication) => void>();
const latest = new Map<string, WrongIndexPublication>();
const retired = new Map<string, Set<string>>();
const capture = new AsyncLocalStorage<{
  active: boolean;
  publications: WrongIndexPublication[];
  truncated: boolean;
}>();

/** Per-call capture, including concurrent composite tools, without global mixing. */
export async function captureWrongIndexPublications<T>(
  work: () => Promise<T>,
): Promise<{ value: T; publications: WrongIndexPublication[]; truncated: boolean }> {
  const scope = { active: true, publications: [] as WrongIndexPublication[], truncated: false };
  return capture.run(scope, async () => {
    try {
      const value = await work();
      return { value, publications: [...scope.publications], truncated: scope.truncated };
    } finally {
      scope.active = false;
    }
  });
}

/** Internal metadata, intentionally absent from JSON/model-facing payloads. */
export function getWrongIndexPublication(result: unknown): WrongIndexPublication | undefined {
  return result !== null && typeof result === 'object' ? metadata.get(result) : undefined;
}
export function onWrongIndexPublication(
  listener: (publication: WrongIndexPublication) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function acceptWrongIndexQuery<T>(
  reply: WrongIndexPublication & { result: T },
  projectRoot: string,
  indexDir: string,
): T {
  const { result, ...rest } = reply;
  const publication = { ...rest, projectRoot, indexDir };
  if (publication.indexCorrupt)
    throw new WrongIndexRemoteError({
      code: 'DATABASE_CORRUPT',
      message: 'The service reports a damaged index; check or rebuild it before using the results',
    });
  if (publication.publicationPending)
    throw new WrongIndexRemoteError({
      code: 'INDEX_DEGRADED',
      message: 'Index publication is pending; retry after the committed generation is recorded',
    });
  const key = process.platform === 'win32' ? indexDir.toLowerCase() : indexDir;
  const previous = latest.get(key);
  const lineage = (p: WrongIndexPublication) => JSON.stringify([p.daemonInstanceId, p.projectId]);
  if (
    retired.get(key)?.has(lineage(publication)) ||
    (previous?.daemonInstanceId === publication.daemonInstanceId &&
      previous.projectId === publication.projectId &&
      previous.generation > publication.generation)
  ) {
    throw new WrongIndexRemoteError({
      code: 'INDEX_DEGRADED',
      message: 'This index snapshot was superseded; retry the query',
    });
  }
  if (previous && lineage(previous) !== lineage(publication)) {
    const instances = retired.get(key) ?? new Set<string>();
    instances.add(lineage(previous));
    while (instances.size > 4) instances.delete(instances.values().next().value as string);
    retired.set(key, instances);
  }
  if (
    publication.graphStamp === undefined &&
    previous?.daemonInstanceId === publication.daemonInstanceId &&
    previous.projectId === publication.projectId &&
    previous.generation === publication.generation
  )
    publication.graphStamp = previous.graphStamp;
  const identity = (p: WrongIndexPublication | undefined) =>
    JSON.stringify(
      p && [
        p.daemonInstanceId,
        p.projectId,
        p.generation,
        p.graphStamp,
        p.indexing,
        p.freshness,
        p.lastError,
      ],
    );
  if (identity(previous) !== identity(publication)) {
    latest.delete(key);
    latest.set(key, publication);
    while (latest.size > 128) {
      const oldest = latest.keys().next().value as string;
      latest.delete(oldest);
      retired.delete(oldest);
    }
    for (const listener of listeners) {
      try {
        listener(publication);
      } catch {
        /* Observers cannot fail a query. */
      }
    }
  }
  if (result !== null && typeof result === 'object') metadata.set(result, publication);
  const scope = capture.getStore();
  if (scope?.active) {
    if (scope.publications.length < 32) scope.publications.push(publication);
    else scope.truncated = true;
  }
  return result;
}
