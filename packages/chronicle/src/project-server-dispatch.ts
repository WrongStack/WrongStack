import type { ChronicleJournal } from './journal.js';
import type { ChronicleMetricsStore } from './metrics-store.js';
import type {
  ChronicleProjectServerHealth,
  ChronicleServerOperationName,
  ChronicleServerOperations,
} from './project-server-protocol.js';
import type { ChronicleQuery, ChronicleQueryEngine } from './query.js';
import type { ChronicleSqliteJournal } from './sqlite-journal.js';
import type { ChronicleSqliteQueryEngine } from './sqlite-query.js';
import type { ChronicleEvent, ChronicleEventInput } from './types.js';
export interface ChronicleDispatchHost {
  serverHealth(): Promise<ChronicleProjectServerHealth>;
  appendInputs(inputs: ChronicleEventInput[]): Promise<ChronicleEvent[]>;
  flushJournals(): Promise<void>;
  useSqliteStore(): boolean;
  store(): Promise<ChronicleSqliteJournal>;
  journalForToday(): ChronicleJournal;
  queryEngine(): Promise<ChronicleQueryEngine | ChronicleSqliteQueryEngine>;
  refreshMetrics(): Promise<ChronicleServerOperations['metrics']['result']['refreshed']>;
  metrics(): ChronicleMetricsStore;
}

/** True when the only narrowing is a time window/page — no genuinely ad hoc
 *  filter (text/path/provider/model/session/etc.) that fixed-dimension
 *  aggregation in ChronicleMetricsStore can't answer. */
function isDefaultView(query: ChronicleQuery): boolean {
  const { from, to, limit, order, cursor, ...rest } = query;
  return Object.values(rest).every((value) => value === undefined);
}
export async function dispatchChronicle<O extends ChronicleServerOperationName>(
  host: ChronicleDispatchHost,
  op: O,
  rawArgs: unknown,
): Promise<ChronicleServerOperations[O]['result']> {
  switch (op) {
    case 'ping':
      return (await host.serverHealth()) as ChronicleServerOperations[O]['result'];
    case 'append': {
      const args = rawArgs as ChronicleServerOperations['append']['args'];
      return (await host.appendInputs(args.inputs)) as ChronicleServerOperations[O]['result'];
    }
    case 'flush':
      await host.flushJournals();
      return undefined as ChronicleServerOperations[O]['result'];
    case 'purge': {
      const args = rawArgs as ChronicleServerOperations['purge']['args'];
      return host.useSqliteStore()
        ? ((await (await host.store()).purge(args)) as ChronicleServerOperations[O]['result'])
        : ((await host.journalForToday().purge(args)) as ChronicleServerOperations[O]['result']);
    }
    case 'query': {
      const args = rawArgs as ChronicleServerOperations['query']['args'];
      const engine = await host.queryEngine();
      // The unfiltered view reads only its page from SQLite; its summary comes from the
      // metrics store below, so streaming the whole journal for one would be thrown away.
      const result =
        isDefaultView(args.query) && 'defaultViewPage' in engine
          ? engine.defaultViewPage(args.query)
          : await engine.query(args.query);
      // The default/unfiltered view (only from/to/limit/order/cursor set) is
      // servable from the incrementally-refreshed metrics store instead of
      // the summary the query engine just computed by scanning matched
      // events — any other filter (text/path/provider/model/session/etc.)
      // keeps the raw-scan summary, since fixed-dimension aggregation can't
      // answer genuinely ad hoc filters.
      if (isDefaultView(args.query)) {
        await host.refreshMetrics();
        result.summary = host.metrics().defaultSummary({
          ...(args.query.from ? { from: args.query.from } : {}),
          ...(args.query.to ? { to: args.query.to } : {}),
        });
      }
      return result as ChronicleServerOperations[O]['result'];
    }
    case 'facet': {
      const args = rawArgs as ChronicleServerOperations['facet']['args'];
      const engine = await host.queryEngine();
      return {
        values: await engine.facet(args.field, args.query, args.limit),
        diagnostics: engine.diagnostics,
      } as ChronicleServerOperations[O]['result'];
    }
    case 'facets': {
      const args = rawArgs as ChronicleServerOperations['facets']['args'];
      const engine = await host.queryEngine();
      return {
        values: await engine.facets(args.fields, args.query, args.limit),
        diagnostics: engine.diagnostics,
      } as ChronicleServerOperations[O]['result'];
    }
    case 'graph': {
      const args = rawArgs as ChronicleServerOperations['graph']['args'];
      return (await (
        await host.queryEngine()
      ).graph(args.seed, args.hops, args.maxNodes)) as ChronicleServerOperations[O]['result'];
    }
    case 'metrics': {
      const args = rawArgs as ChronicleServerOperations['metrics']['args'];
      const refreshed =
        args.refresh === false
          ? { ingestedEvents: 0, ingestedBytes: 0, sourceFiles: 0, invalidLines: 0 }
          : await host.refreshMetrics();
      if (args.refresh === false) {
        // Keep the projection converging without putting historical indexing
        // latency on the caller's critical path.
        void host.refreshMetrics().catch(() => {});
      }
      const store = host.metrics();
      const data =
        args.view === 'providers'
          ? store.providerDaily(args.providers)
          : args.view === 'tasks'
            ? store.taskOutcomes(args.tasks)
            : args.view === 'files'
              ? store.fileLineage(args.files)
              : store.summary();
      return { refreshed, data } as ChronicleServerOperations[O]['result'];
    }
  }
}
