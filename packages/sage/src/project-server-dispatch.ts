import type { ScoredEntry } from '@wrongstack/contracts/types';
import type { CompleteSageStore } from './project-server-options.js';
import {
  assertDispatchArgs,
  type SageProjectServerInfo,
  type SageServerOperationName,
  type SageServerOperations,
} from './project-server-protocol.js';
export interface SageDispatchHost {
  store: CompleteSageStore;
  ready: Promise<void>;
  serverStatus: () => Promise<SageProjectServerInfo>;
  runHygiene: (args: SageServerOperations['hygiene']['args']) => Promise<unknown>;
  importLegacyFiles: (files: string[]) => Promise<unknown>;
  maintenance: (args: SageServerOperations['maintenance']['args']) => unknown;
  doctor: (args: SageServerOperations['doctor']['args']) => Promise<unknown>;
}
export async function dispatch(
  host: SageDispatchHost,
  op: SageServerOperationName,
  rawArgs: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const { store, ready, serverStatus, runHygiene, importLegacyFiles } = host;
  assertDispatchArgs(op, rawArgs);
  await ready;
  switch (op) {
    case 'getHqSyncVersion':
      return store.getHqSyncVersion();
    case 'listHqSync':
      return store.listHqSync((rawArgs as SageServerOperations['listHqSync']['args']).after);
    case 'applyHqSync':
      return store.applyHqSync((rawArgs as SageServerOperations['applyHqSync']['args']).records);
    case 'ping':
      return serverStatus();
    case 'readAll':
      return store.readAll();
    case 'read': {
      const args = rawArgs as SageServerOperations['read']['args'];
      return store.read(args.scope);
    }
    case 'remember': {
      const args = rawArgs as SageServerOperations['remember']['args'];
      return store.remember(args.text, args.scope, args.metadata);
    }
    case 'forget': {
      const args = rawArgs as SageServerOperations['forget']['args'];
      return store.forget(args.query, args.scope);
    }
    case 'consolidate': {
      const args = rawArgs as SageServerOperations['consolidate']['args'];
      return store.consolidate(args.scope);
    }
    case 'clear': {
      const args = rawArgs as SageServerOperations['clear']['args'];
      return store.clear(args.scope);
    }
    case 'list': {
      const args = rawArgs as SageServerOperations['list']['args'];
      return store.list(args.scope, args.limit);
    }
    case 'search': {
      const args = rawArgs as SageServerOperations['search']['args'];
      return store.search(args.query, args.scope, args.limit);
    }
    case 'findRelated': {
      const args = rawArgs as SageServerOperations['findRelated']['args'];
      const related = store.findRelated?.(args.text, args.scope, args.limit);
      return related ?? store.search(args.text, args.scope, args.limit);
    }
    case 'scoreRelevant': {
      const args = rawArgs as SageServerOperations['scoreRelevant']['args'];
      const scored = store.scoreRelevant?.(args.context, args.scope, args.limit);
      if (scored) return scored;
      const fallback = await store.search(args.context.currentTask, args.scope, args.limit);
      return fallback.map(
        (entry, index): ScoredEntry => ({
          ...entry,
          score: Math.max(0.1, 1 - index * 0.05),
          matchReason: 'sage-server lexical fallback',
        }),
      );
    }
    case 'stats':
      return store.stats();
    case 'listSage': {
      const args = rawArgs as SageServerOperations['listSage']['args'];
      return store.listSage(args.statuses);
    }
    case 'listSagePage': {
      const args = rawArgs as SageServerOperations['listSagePage']['args'];
      return store.listSagePage(args.options);
    }
    case 'getSage': {
      const args = rawArgs as SageServerOperations['getSage']['args'];
      return store.getSage(args.id);
    }
    case 'rememberSage': {
      const args = rawArgs as SageServerOperations['rememberSage']['args'];
      return store.rememberSage(args.input);
    }
    case 'updateSage': {
      const args = rawArgs as SageServerOperations['updateSage']['args'];
      // Force guard: any `status:'deleted'` patch arriving over IPC must
      // carry `force: true`. The store-side check in `sqlite-store-update.ts`
      // only blocks permanent-persistence deletes; non-permanent memories
      // were soft-deletable via raw `{status:'deleted'}` patch without
      // any authorization. This dispatch-layer gate closes that gap
      // regardless of the patch's other fields.
      //
      // Note: the in-process candidate-resolution path
      // (`sqlite-store-candidates.ts:resolveSqliteCandidate`) deliberately
      // does NOT pass `force: true`. Its target read is captured before
      // this gate applies, and the store-side permanent-guard still fires
      // when the target is permanent at delete-time. Adding `force: true`
      // there would silently succeed for permanent-target deletion races,
      // which the `sqlite-behavior-coverage.test.ts` promotion-race test
      // covers as `applied: false`. Two paths, two contracts:
      //   - IPC `updateSage` patch → force required.
      //   - In-process `ctx.updateSage` from candidate resolve → force
      //     intentionally omitted so the permanent-guard fires.
      if (!args?.id || !args?.patch) {
        throw new Error('SAGE IPC updateSage requires { id, patch } args.');
      }
      if (args.patch.status === 'deleted' && args.patch.force !== true) {
        throw new Error(
          `SAGE IPC updateSage cannot set status:'deleted' without force:true. ` +
            `Pass { force: true } in the patch.`,
        );
      }
      return store.updateSage(args.id, args.patch);
    }
    case 'deleteSage': {
      const args = rawArgs as SageServerOperations['deleteSage']['args'];
      return store.deleteSage(args.id, args.reason, args.options);
    }
    case 'retrieveForPath': {
      const args = rawArgs as SageServerOperations['retrieveForPath']['args'];
      return store.retrieveForPath([args.options.path], args.options);
    }
    case 'searchSage': {
      const args = rawArgs as SageServerOperations['searchSage']['args'];
      return store.searchSage(args.query, args.options);
    }
    case 'searchSageWithBreakdown': {
      const args = rawArgs as SageServerOperations['searchSageWithBreakdown']['args'];
      // The rich variant is optional on the surface — only the
      // vector-augmented in-process port implements it. When the
      // daemon is talking to a non-augmented store, throw a
      // recognizable error so the client can fall back to
      // `searchSage` (which always works).
      if (typeof store.searchSageWithBreakdown !== 'function') {
        throw new Error('searchSageWithBreakdown is not available on this store');
      }
      return store.searchSageWithBreakdown(args.query, args.options);
    }
    case 'unifiedSearch': {
      const args = rawArgs as SageServerOperations['unifiedSearch']['args'];
      return store.unifiedSearchService(args.query, args.options);
    }
    case 'findRelatedSage': {
      const args = rawArgs as SageServerOperations['findRelatedSage']['args'];
      return store.findRelatedSage(args.memoryIds, args.options);
    }
    case 'recordInjection': {
      const args = rawArgs as SageServerOperations['recordInjection']['args'];
      return store.recordInjection(args.memoryIds, args.trigger, args.sessionId);
    }
    case 'recordUse': {
      const args = rawArgs as SageServerOperations['recordUse']['args'];
      return store.recordUse(args.memoryIds, args.source, args.sessionId);
    }
    case 'retrieveForAudience': {
      const args = rawArgs as SageServerOperations['retrieveForAudience']['args'];
      return store.retrieveForAudience(
        args.context,
        args.limit,
        undefined,
        args.sessionId,
        args.includeAllSessions,
      );
    }
    case 'graphFor': {
      const args = rawArgs as SageServerOperations['graphFor']['args'];
      return store.graphFor(args.query, args.maxDepth, args.limit);
    }
    case 'verify': {
      const args = rawArgs as SageServerOperations['verify']['args'];
      return store.verify(args.memoryId, signal);
    }
    case 'verifyForPaths': {
      const args = rawArgs as SageServerOperations['verifyForPaths']['args'];
      return store.verifyForPaths(args.paths, signal);
    }
    case 'hygiene':
      return runHygiene(rawArgs as SageServerOperations['hygiene']['args']);
    case 'listCandidates': {
      const args = rawArgs as SageServerOperations['listCandidates']['args'];
      return store.listCandidates(args.includeResolved);
    }
    case 'createCandidate': {
      const args = rawArgs as SageServerOperations['createCandidate']['args'];
      return store.createCandidate(args.input);
    }
    case 'resolveCandidate': {
      const args = rawArgs as SageServerOperations['resolveCandidate']['args'];
      return store.resolveCandidate(args.candidateId, args.decision, args.reason);
    }
    case 'acceptCandidate': {
      const args = rawArgs as SageServerOperations['acceptCandidate']['args'];
      return store.acceptCandidate(args.candidateId);
    }
    case 'rejectCandidate': {
      const args = rawArgs as SageServerOperations['rejectCandidate']['args'];
      return store.rejectCandidate(args.candidateId, args.reason);
    }
    case 'recoverSage': {
      const args = rawArgs as SageServerOperations['recoverSage']['args'];
      return store.recoverSage(args.id, args.reason);
    }
    case 'backfillRecoverable': {
      const args = rawArgs as SageServerOperations['backfillRecoverable']['args'];
      return store.backfillRecoverable(args.options);
    }
    case 'findMemoriesForFile': {
      const args = rawArgs as SageServerOperations['findMemoriesForFile']['args'];
      return store.findMemoriesForFile(args.filePath, args.options);
    }
    case 'readAudit': {
      const args = rawArgs as SageServerOperations['readAudit']['args'];
      return store.readAudit(args.limit);
    }
    case 'importLegacyFiles': {
      const args = rawArgs as SageServerOperations['importLegacyFiles']['args'];
      return importLegacyFiles(args.files);
    }
    case 'consolidateSession': {
      const args = rawArgs as SageServerOperations['consolidateSession']['args'];
      return store.consolidateSession(args.input);
    }
    case 'maintenance':
      return host.maintenance(rawArgs as SageServerOperations['maintenance']['args']);
    case 'doctor':
      return host.doctor((rawArgs ?? {}) as SageServerOperations['doctor']['args']);
  }
}
