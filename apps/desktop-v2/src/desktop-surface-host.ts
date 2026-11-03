import type {
  ConfirmOptions,
  SurfaceClient,
  SurfaceHost,
  SurfaceMessage,
  SurfaceSendOptions,
} from '@wrongstack/project-surfaces/host';
import { createSageSocket, type SurfaceSend } from '@wrongstack/project-surfaces/sage/socket';
import { useRef } from 'react';
import { type EngineHttp, EngineHttpError } from './engine-http';
import type { BackendStream } from './engine-stream';
import type { JournalTail } from './journal-tail';

/** Requests this host sent, newest last; replies carrying other ids belong to other views. */
const OWN_REQUEST_LIMIT = 500;

/**
 * The desktop side of the shared project surfaces, on one project's engine. Requests go out on
 * the project connection; replies are read from the journal's live end, and reach a surface
 * when they carry a request id it sent or no request id at all.
 */
export function desktopSurfaceHost(
  stream: BackendStream,
  tail: JournalTail,
  http: EngineHttp,
  confirm: (options: ConfirmOptions) => Promise<boolean>,
): { host: SurfaceHost; attach: () => () => void } {
  const own = new Set<string>();
  const handlers = new Map<string, Set<(message: SurfaceMessage) => void>>();
  const deliver = (message: SurfaceMessage) => {
    for (const handler of handlers.get(message.type) ?? []) handler(message);
  };
  /** Follows the journal while the surface is mounted; returns the detach. */
  const attach = () =>
    tail.listen((event) => {
      if (!handlers.has(event.type)) return;
      const id = event.payload['requestId'];
      if (typeof id === 'string' && !own.has(id)) return;
      deliver({ type: event.type, payload: event.payload });
    });
  const send: SurfaceSend = (message, options?: SurfaceSendOptions) => {
    const payload = { ...message.payload };
    const requestId =
      options?.requestId ??
      (typeof payload['requestId'] === 'string' ? payload['requestId'] : crypto.randomUUID());
    own.add(requestId);
    if (own.size > OWN_REQUEST_LIMIT) own.delete(own.values().next().value as string);
    // Sent once the tail has a position, so its reply cannot land before the tail reads.
    // A request the engine never received fails where the surface waits for its reply.
    void tail
      .ready()
      .then(() => stream.send(message.type, { ...payload, requestId }))
      .catch((error: unknown) =>
        deliver({
          type: message.type,
          payload: { requestId, error: error instanceof Error ? error.message : String(error) },
        }),
      );
  };
  const client: SurfaceClient = {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set<(message: SurfaceMessage) => void>();
      handlers.set(type, set);
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
    findMemoriesForFile: (payload, options) =>
      send({ type: 'memory.sage.forFile', payload: { ...payload } }, options),
  };
  const socket = createSageSocket(client, send);
  const host: SurfaceHost = {
    useSageSocket: () => socket,
    getClient: () => client,
    useConnected: () => true,
    useNavigateBack: () => undefined,
    useScrollRestore: <T extends HTMLElement>(_key: string) => useRef<T | null>(null),
    useValidityReview: () => undefined,
    useCompanionReview: () => undefined,
    confirm,
    fetch: async (path, init) => {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      try {
        const data = await http(path, init?.method ?? 'GET', body);
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (error) {
        if (!(error instanceof EngineHttpError)) throw error;
        return new Response(JSON.stringify(error.data), {
          status: error.status,
          headers: { 'content-type': 'application/json' },
        });
      }
    },
    requestRoster: (type, payload) =>
      stream.operations.request(type, payload, [type, 'list'], { timeoutMs: 15000 }),
  };
  return { host, attach };
}
