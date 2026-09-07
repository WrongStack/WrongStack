import {
  CHRONICLE_FACET_FIELDS,
  type ChronicleFacet,
  type ChronicleProjectAccess,
  type ChronicleQuery,
  createChronicleProjectAccess,
} from '@wrongstack/core/chronicle';
import type { WebSocket } from 'ws';
import { clampLimit } from './ws-payload-validation.js';
import type { WSClientMessage, WSServerMessage } from './types.js';

export interface ChronicleRouteContext {
  getProjectRoot: () => string;
  send: (ws: WebSocket, message: WSServerMessage) => void;
  getChronicleAccess?: (() => Pick<ChronicleProjectAccess, 'mode' | 'call'>) | undefined;
}

const accessCache = new Map<string, ChronicleProjectAccess>();
const ACCESS_CACHE_MAX_PROJECTS = 8;

function defaultChronicleAccess(projectRoot: string): ChronicleProjectAccess {
  let access = accessCache.get(projectRoot);
  if (access) {
    accessCache.delete(projectRoot);
    accessCache.set(projectRoot, access);
    return access;
  }
  access = createChronicleProjectAccess({ projectRoot });
  while (accessCache.size >= ACCESS_CACHE_MAX_PROJECTS) {
    const oldestKey = accessCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = accessCache.get(oldestKey);
    accessCache.delete(oldestKey);
    void oldest?.close();
  }
  accessCache.set(projectRoot, access);
  return access;
}

/** Canonical Chronicle query/facet/graph handler shared by every WebUI host. */
export async function handleChronicleRoute(
  ctx: ChronicleRouteContext,
  ws: WebSocket,
  message: WSClientMessage,
): Promise<boolean> {
  if (!message.type.startsWith('chronicle.')) return false;
  if (message.type === 'chronicle.status') {
    try {
      const access = ctx.getChronicleAccess?.() ?? defaultChronicleAccess(ctx.getProjectRoot());
      const health = await access.call('ping', {});
      ctx.send(ws, {
        type: 'chronicle.status_result',
        payload: {
          mode: access.mode,
          ...health,
          pipeline: {
            collection: 'session-event-adapters',
            processing:
              access.mode === 'server' ? 'project-chronicle-server' : 'inline-chronicle-fallback',
            storage: health.chronicleDirectory,
            serving: 'webui-server',
          },
        },
      });
    } catch (error) {
      ctx.send(ws, {
        type: 'chronicle.error',
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
    }
    return true;
  }
  if (message.type === 'chronicle.metrics') {
    const payload = (message.payload ?? {}) as {
      view?: 'summary' | 'providers' | 'tasks' | 'files';
      from?: string;
      to?: string;
      path?: string;
      taskId?: string;
      boardId?: string;
      sessionId?: string;
      status?: string;
      limit?: number;
    };
    const view = payload.view ?? 'summary';
    try {
      const access = ctx.getChronicleAccess?.() ?? defaultChronicleAccess(ctx.getProjectRoot());
      const result = await access.call('metrics', {
        view,
        ...(view === 'providers'
          ? {
              providers: {
                ...(payload.from ? { from: payload.from } : {}),
                ...(payload.to ? { to: payload.to } : {}),
              },
            }
          : {}),
        ...(view === 'tasks'
          ? {
              tasks: {
                ...(payload.boardId ? { boardId: payload.boardId } : {}),
                ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
                ...(payload.status ? { status: payload.status } : {}),
                ...(payload.limit !== undefined ? { limit: payload.limit } : {}),
              },
            }
          : {}),
        ...(view === 'files'
          ? {
              files: {
                ...(payload.path ? { path: payload.path } : {}),
                ...(payload.taskId ? { taskId: payload.taskId } : {}),
                ...(payload.boardId ? { boardId: payload.boardId } : {}),
                ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
                ...(payload.limit !== undefined ? { limit: payload.limit } : {}),
              },
            }
          : {}),
      });
      ctx.send(ws, {
        type: 'chronicle.metrics_result',
        payload: { view, refreshed: result.refreshed, data: result.data },
      });
    } catch (error) {
      // node:sqlite unavailable or a corrupt metrics.db — surface, don't crash.
      ctx.send(ws, {
        type: 'chronicle.error',
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
    }
    return true;
  }
  if (
    message.type !== 'chronicle.query' &&
    message.type !== 'chronicle.facet' &&
    message.type !== 'chronicle.facets' &&
    message.type !== 'chronicle.graph'
  ) {
    return false;
  }
  try {
    const access = ctx.getChronicleAccess?.() ?? defaultChronicleAccess(ctx.getProjectRoot());
    switch (message.type) {
      case 'chronicle.query': {
        const payload = (message.payload ?? {}) as { query?: ChronicleQuery };
        ctx.send(ws, {
          type: 'chronicle.query_result',
          payload: await access.call('query', { query: payload.query ?? {} }),
        });
        return true;
      }
      case 'chronicle.facet': {
        const payload = (message.payload ?? {}) as {
          field?: ChronicleFacet;
          query?: ChronicleQuery;
          limit?: number;
        };
        if (!payload.field || !CHRONICLE_FACET_FIELDS.has(payload.field)) {
          ctx.send(ws, {
            type: 'chronicle.error',
            payload: { message: 'Invalid Chronicle facet field.' },
          });
          return true;
        }
        ctx.send(ws, {
          type: 'chronicle.facet_result',
          payload: {
            field: payload.field,
            ...(await access.call('facet', {
              field: payload.field,
              query: payload.query ?? {},
              // S10 (H1): mirror the HTTP chronicle.query limit cap (10000).
              limit: clampLimit(payload.limit, 1000, 10000),
            })),
          },
        });
        return true;
      }
      case 'chronicle.facets': {
        const payload = (message.payload ?? {}) as {
          fields?: ChronicleFacet[];
          query?: ChronicleQuery;
          limit?: number;
        };
        if (
          !Array.isArray(payload.fields) ||
          payload.fields.length === 0 ||
          payload.fields.some((field) => !CHRONICLE_FACET_FIELDS.has(field))
        ) {
          ctx.send(ws, {
            type: 'chronicle.error',
            payload: { message: 'Invalid Chronicle facet fields.' },
          });
          return true;
        }
        ctx.send(ws, {
          type: 'chronicle.facets_result',
          payload: await access.call('facets', {
            fields: payload.fields,
            query: payload.query ?? {},
            limit: clampLimit(payload.limit, 1000, 10000),
          }),
        });
        return true;
      }
      case 'chronicle.graph': {
        const payload = (message.payload ?? {}) as {
          seed?: ChronicleQuery;
          hops?: number;
          maxNodes?: number;
        };
        ctx.send(ws, {
          type: 'chronicle.graph_result',
          // S10 (H1): `chronicle.graph {maxNodes: 1e9}` previously
          // materialised the entire journal (measured at 7.2 GB / 7
          // days) into a Map and then ran a cubic edge build. Cap it
          // to 1000 — the existing HTTP `chronicle.graph` route caps
          // at 1000 too, so the WebSocket surface now matches.
          payload: await access.call('graph', {
            seed: payload.seed ?? {},
            hops: clampLimit(payload.hops, 1, 5),
            maxNodes: clampLimit(payload.maxNodes, 1000, 1000),
          }),
        });
        return true;
      }
      default:
        return false;
    }
  } catch (error) {
    ctx.send(ws, {
      type: 'chronicle.error',
      payload: { message: error instanceof Error ? error.message : String(error) },
    });
    return true;
  }
}
