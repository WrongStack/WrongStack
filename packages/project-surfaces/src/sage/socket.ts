import type { SageSocket, SurfaceClient, SurfaceSendOptions } from '../host';

/** A request as an app's connection sends it. */
export type SurfaceSend = (
  message: { type: string; payload?: Record<string, unknown> },
  options?: SurfaceSendOptions,
) => void;

/**
 * The SAGE requests for an app that has a plain send function rather than the WebUI's client.
 * Message shapes match the WebUI client's own wrappers.
 */
export function createSageSocket(client: SurfaceClient, send: SurfaceSend): SageSocket {
  const payload = (value: object | undefined) => ({ ...(value as Record<string, unknown>) });
  return {
    client,
    listSageMemories: (options) => send({ type: 'memory.sage.list' }, options),
    listSageMemoriesPage: (params, options) =>
      send({ type: 'memory.sage.listPage', payload: payload(params) }, options),
    listMemoryCandidates: (params, options) =>
      send({ type: 'memory.sage.listCandidates', payload: payload(params) }, options),
    searchSageBreakdown: (params, options) =>
      send(
        {
          type: 'memory.sage.searchBreakdown',
          payload: {
            query: params.query,
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
            ...(params.includeStale !== undefined ? { includeStale: params.includeStale } : {}),
          },
        },
        options,
      ),
    getSageGraph: (query, params, options) =>
      send({ type: 'memory.sage.graph', payload: { query, ...params } }, options),
    updateSage: (id, patch, options) =>
      send({ type: 'memory.sage.update', payload: { id, ...payload(patch) } }, options),
    deleteSage: (id, reason, options) =>
      send({
        type: 'memory.sage.delete',
        payload: {
          id,
          force: true,
          ...(reason !== undefined ? { reason } : {}),
          ...(options?.neverInject !== undefined ? { neverInject: options.neverInject } : {}),
        },
      }),
    rememberSage: (opts, options) =>
      send({ type: 'memory.sage.remember', payload: payload(opts) }, options),
    recoverSage: (opts, options) =>
      send({ type: 'memory.sage.recover', payload: payload(opts) }, options),
    resolveMemoryCandidate: (opts, options) =>
      send({ type: 'memory.sage.candidateResolve', payload: payload(opts) }, options),
    sageDoctor: (opts, options) =>
      send({ type: 'memory.sage.doctor', payload: payload(opts) }, options),
  };
}
