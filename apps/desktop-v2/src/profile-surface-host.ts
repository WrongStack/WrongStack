import type {
  ConfirmOptions,
  SurfaceClient,
  SurfaceHost,
  SurfaceMessage,
} from '@wrongstack/project-surfaces/host';
import type { ProviderClient } from '@wrongstack/project-surfaces/providers/provider-host';
import { createSageSocket, type SurfaceSend } from '@wrongstack/project-surfaces/sage/socket';
import type { SetupModelResult } from '@wrongstack/project-surfaces/setup/setup-host';
import { useRef, useSyncExternalStore } from 'react';
import type { EngineHttp } from './engine-http';
import { EngineHttpError } from './engine-http-error';
import type { EngineCommand } from './engine-operations';
import type { BackendStream } from './engine-stream';
import { record } from './engine-values';
import { emptyMemoryReviews, MemoryReviewStore, type MemoryReviews } from './memory-reviews';

/** Strings of a list preference; anything else reads as empty. */
export function prefList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** The fallback profiles preference: chains of model references by name. */
export function prefProfiles(value: unknown): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(record(value)).map(([name, chain]) => [name, prefList(chain)]),
  );
}

/**
 * The shared surfaces on the profile engine: requests go out on its connection and every frame
 * it reads reaches the handlers registered for its type.
 */
export function profileSurfaceHost(
  stream: BackendStream,
  http: EngineHttp,
  confirm: (options: ConfirmOptions) => Promise<boolean>,
  /** Memory reviews from the project engines, where conversations run. */
  memoryReviews: MemoryReviews = emptyMemoryReviews,
): { host: SurfaceHost; client: ProviderClient } {
  const on = (type: string, handler: (message: SurfaceMessage) => void) =>
    stream.listen((event) => {
      if (event.type === type) handler({ type, payload: event.payload });
    });
  const send: SurfaceSend = (message) => {
    void stream.send(message.type, { ...message.payload }).catch(() => undefined);
  };
  const surfaceClient: SurfaceClient = {
    on,
    findMemoriesForFile: (payload) =>
      send({ type: 'memory.sage.forFile', payload: { ...(payload as Record<string, unknown>) } }),
    send: (message) => send({ type: message.type, payload: { ...message.payload } }),
  };
  const socket = createSageSocket(surfaceClient, send);
  const reviews = new MemoryReviewStore(memoryReviews);
  const host: SurfaceHost = {
    useSageSocket: () => socket,
    getClient: () => surfaceClient,
    useConnected: () => true,
    useNavigateBack: () => undefined,
    useScrollRestore: <T extends HTMLElement>(_key: string) => useRef<T | null>(null),
    useValidityReview: (memoryId) =>
      useSyncExternalStore(reviews.subscribe, () => reviews.reviews.validity[memoryId]),
    useCompanionReview: (memoryId) =>
      useSyncExternalStore(reviews.subscribe, () =>
        memoryId ? reviews.reviews.companion[memoryId] : undefined,
      ),
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
  return {
    host,
    client: {
      send: (message) => send({ type: message.type, payload: { ...message.payload } }),
      on,
    },
  };
}

/**
 * Makes a first-run setup choice the profile's default model. Starting takes the user back to
 * the conversation that sent them to settings; saving only reports the new default.
 */
export async function chooseSetupModel(
  command: EngineCommand,
  choice: { provider: string; model: string; start: boolean },
  done: { configured(provider: string, model: string): void; saved(text: string): void },
): Promise<SetupModelResult> {
  const { provider, model } = choice;
  const reply = await command('model.switch', { provider, model }, ['model.switch_result']);
  if (reply['success'] === false)
    return { success: false, message: String(reply['message'] ?? '') };
  if (choice.start) done.configured(provider, model);
  else done.saved(`${provider} / ${model} is now the default model.`);
  return { success: true };
}
