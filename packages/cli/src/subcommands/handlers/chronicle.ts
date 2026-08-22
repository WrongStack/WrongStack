import { statSync } from 'node:fs';
import path from 'node:path';
import {
  type ChronicleFacet,
  type ChronicleMetricsView,
  type ChronicleQuery,
  chronicleProjectServerMetadataPath,
  compactChronicleSqlite,
  createChronicleProjectAccess,
  resolveChronicleProjectServerOptions,
} from '@wrongstack/core/chronicle';
import type { SubcommandHandler } from '../contracts.js';

const facets = new Set<ChronicleFacet>([
  'eventType',
  'outcome',
  'projectId',
  'sessionId',
  'agentId',
  'taskId',
  'providerId',
  'modelId',
  'resourceKind',
  'resourcePath',
  'toolCallId',
]);

/** `wstack chronicle` — query the cross-session provenance ledger. */
export const chronicleCmd: SubcommandHandler = async (args, deps) => {
  const operation = args[0] ?? 'query';
  if (operation === 'help' || operation === '--help' || operation === '-h') {
    deps.renderer.write(usage());
    return 0;
  }
  let access: ReturnType<typeof createChronicleProjectAccess> | undefined;
  try {
    if (operation === 'compact') {
      if (args.length !== 1) {
        throw new Error('Usage: wstack chronicle compact (stop the Chronicle daemon first)');
      }
      const resolved = resolveChronicleProjectServerOptions({
        projectRoot: deps.projectRoot,
        userHome: deps.userHome,
      });
      const result = compactChronicleSqlite({
        dbPath: path.join(resolved.projectDir, 'chronicle', 'chronicle.sqlite'),
        endpointMetadataPath: chronicleProjectServerMetadataPath(resolved.projectDir),
      });
      deps.renderer.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    access = createChronicleProjectAccess({
      projectRoot: deps.projectRoot,
      userHome: deps.userHome,
    });
    if (operation === 'status') {
      const health = await access.call('ping', {});
      deps.renderer.write(
        `${JSON.stringify(
          {
            mode: access.mode,
            owner: {
              pid: health.pid,
              uptimeMs: health.uptimeMs,
              clients: health.clients,
              activeRequests: health.activeRequests,
              endpoint: health.endpoint,
            },
            pipeline: {
              collection: 'session-event-adapters',
              processing:
                access.mode === 'server' ? 'project-chronicle-server' : 'inline-chronicle-fallback',
              storage: health.chronicleDirectory,
              serving: 'wstack-chronicle-cli',
            },
            journal: health.journal,
            watcher: health.watcher,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    // `wstack chronicle prune [--dry-run] [--days N]`
    if (operation === 'prune') {
      // `parseArgs` strips every `--flag` from argv before the dispatcher calls
      // this handler (boot.ts:358 passes `positional.slice(1)`), so scanning
      // `args` alone saw neither flag: `prune --days 7 --dry-run` — the form
      // this file's own usage text prints — resolved to a REAL purge at the
      // 30-day default. `deps.flags` is what the top-level parse captured; a
      // local scan still wins so a directly-invoked handler keeps working.
      const flags = deps.flags ?? {};
      const dryRun =
        args.includes('--dry-run') ||
        args.includes('-n') ||
        flags['dry-run'] === true ||
        flags['dry-run'] === 'true' ||
        flags['n'] === true;
      const daysIndex = args.indexOf('--days');
      const rawDays =
        daysIndex >= 0 && daysIndex + 1 < args.length
          ? args[daysIndex + 1]
          : typeof flags['days'] === 'string'
            ? flags['days']
            : undefined;
      const days = rawDays ? parseInt(rawDays, 10) : 30;
      if (!Number.isFinite(days) || days < 1) {
        deps.renderer.writeError(
          `Invalid retention days: ${rawDays ?? ''}. Use --days N (positive integer).\n`,
        );
        return 1;
      }
      const result = await access.call('purge', { retentionDays: days, dryRun });
      if (dryRun) {
        // "entries" rather than "files": SQLite purges whole day-chains, the
        // legacy store purged partition files. Both are entries to the caller.
        deps.renderer.write(`Dry-run: would delete ${result.candidates?.length ?? 0} entries`);
        if (result.candidates?.length) {
          const totalBytes = result.candidates.reduce((sum: number, f: string) => {
            try {
              return sum + statSync(f).size;
            } catch {
              return sum;
            }
          }, 0);
          deps.renderer.write(` (${formatBytes(totalBytes)}):\n`);
          for (const file of result.candidates!) {
            const s = tryStat(file);
            const age = s ? `${Math.round((Date.now() - s.mtimeMs) / 86400000)}d` : '?';
            deps.renderer.write(`  ${file}  (${age}, ${formatBytes(s?.size ?? 0)})\n`);
          }
        } else {
          deps.renderer.write('.\n');
        }
      } else {
        const bytes = result.deletedBytes;
        deps.renderer.write(`Purged ${result.deletedCount} entries (${formatBytes(bytes)})`);
        if (result.errors.length) deps.renderer.write(`, ${result.errors.length} errors`);
        deps.renderer.write('.\n');
        for (const err of result.errors) {
          deps.renderer.writeError(`  Error: ${err.file}: ${err.reason}\n`);
        }
      }
      return result.errors.length > 0 ? 1 : 0;
    }

    // `wstack chronicle metrics [providers|tasks|files|summary] [key=value ...]`
    // Incrementally ingests new journal bytes into metrics.db, then queries the
    // derived aggregates instead of streaming raw partitions.
    if (operation === 'metrics') {
      const hasView = Boolean(args[1] && !args[1].includes('='));
      const rawView = hasView ? args[1]! : 'summary';
      if (!isMetricsView(rawView)) {
        deps.renderer.writeError(
          `Unknown metrics view: ${rawView}. Use providers|tasks|files|summary.\n`,
        );
        return 1;
      }
      const view: ChronicleMetricsView = rawView;
      const filters = parseQuery(args.slice(hasView ? 2 : 1));
      try {
        const result = await access.call('metrics', {
          view,
          ...(view === 'providers'
            ? {
                providers: {
                  ...(filters.from ? { from: filters.from } : {}),
                  ...(filters.to ? { to: filters.to } : {}),
                },
              }
            : {}),
          ...(view === 'tasks'
            ? {
                tasks: {
                  ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
                  ...(filters.limit ? { limit: filters.limit } : {}),
                },
              }
            : {}),
          ...(view === 'files'
            ? {
                files: {
                  ...(filters.path ? { path: filters.path } : {}),
                  ...(filters.taskId ? { taskId: filters.taskId } : {}),
                  ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
                  ...(filters.limit ? { limit: filters.limit } : {}),
                },
              }
            : {}),
        });
        deps.renderer.write(
          JSON.stringify({ refreshed: result.refreshed, [view]: result.data }, null, 2) + '\n',
        );
        return 0;
      } catch (error) {
        deps.renderer.writeError(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }

    if (operation === 'facet') {
      const field = args[1] as ChronicleFacet | undefined;
      if (!field || !facets.has(field)) {
        deps.renderer.writeError(`Unknown facet. Use: ${[...facets].join(', ')}\n`);
        return 1;
      }
      const query = parseQuery(args.slice(2));
      const result = await access.call('facet', { field, query });
      deps.renderer.write(JSON.stringify({ field, ...result }, null, 2) + '\n');
      return 0;
    }
    if (operation !== 'query') {
      deps.renderer.writeError(`Unknown Chronicle operation: ${operation}\n${usage()}`);
      return 1;
    }
    const result = await access.call('query', { query: parseQuery(args.slice(1)) });
    deps.renderer.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (error) {
    deps.renderer.writeError(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await access?.close();
  }
};

function isMetricsView(value: string): value is ChronicleMetricsView {
  return ['providers', 'tasks', 'files', 'summary'].includes(value);
}

function parseQuery(tokens: string[]): ChronicleQuery {
  const query: ChronicleQuery = {};
  for (const token of tokens) {
    const split = token.indexOf('=');
    if (split < 1) continue;
    const key = token.slice(0, split),
      value = token.slice(split + 1);
    if (key === 'eventType') query.eventTypes = value.split(',').filter(Boolean);
    else if (key === 'outcome')
      query.outcomes = value.split(',').filter(Boolean) as NonNullable<ChronicleQuery['outcomes']>;
    else if (key === 'resourceKind')
      query.resourceKind = value as NonNullable<ChronicleQuery['resourceKind']>;
    else if (key === 'line' || key === 'limit') query[key] = Number(value);
    else if (key === 'order' && (value === 'asc' || value === 'desc')) query.order = value;
    else if (key.startsWith('tag.')) {
      const tags = query.tags ?? {};
      tags[key.slice(4)] = value;
      query.tags = tags;
    } else if (key.startsWith('attr.')) {
      const attributes = query.attributes ?? {};
      attributes[key.slice(5)] = parseValue(value);
      query.attributes = attributes;
    } else if (isStringQueryKey(key)) query[key] = value;
  }
  return query;
}

function isStringQueryKey(
  key: string,
): key is
  | 'from'
  | 'to'
  | 'projectId'
  | 'sessionId'
  | 'agentId'
  | 'taskId'
  | 'providerId'
  | 'modelId'
  | 'traceId'
  | 'logicalRequestId'
  | 'attemptId'
  | 'toolCallId'
  | 'resourceId'
  | 'path'
  | 'text'
  | 'cursor' {
  return [
    'from',
    'to',
    'projectId',
    'sessionId',
    'agentId',
    'taskId',
    'providerId',
    'modelId',
    'traceId',
    'logicalRequestId',
    'attemptId',
    'toolCallId',
    'resourceId',
    'path',
    'text',
    'cursor',
  ].includes(key);
}

function parseValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function usage(): string {
  return (
    'Usage:\n' +
    '  wstack chronicle query [field=value ...]\n' +
    '  wstack chronicle status\n' +
    '  wstack chronicle facet <field> [field=value ...]\n' +
    '  wstack chronicle metrics [providers|tasks|files|summary] [field=value ...]\n' +
    '  wstack chronicle prune [--days N] [--dry-run]\n' +
    '  wstack chronicle compact\n\n' +
    'Examples:\n' +
    '  wstack chronicle status\n' +
    '  wstack chronicle query path=src/app.ts line=42\n' +
    '  wstack chronicle query providerId=openai outcome=failure\n' +
    '  wstack chronicle query eventType=tool.executed sessionId=<id> limit=50\n' +
    '  wstack chronicle query attr.tool.name=read\n' +
    '  wstack chronicle facet modelId from=2026-07-01T00:00:00Z\n' +
    '  wstack chronicle metrics providers from=2026-07-01\n' +
    '  wstack chronicle metrics files path=src/app.ts\n' +
    '  wstack chronicle metrics tasks limit=20\n' +
    '  wstack chronicle prune --days 7 --dry-run\n' +
    '  wstack chronicle prune --days 30\n' +
    '  wstack chronicle compact\n'
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function tryStat(file: string): { size: number; mtimeMs: number } | undefined {
  try {
    const s = statSync(file);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return undefined;
  }
}
