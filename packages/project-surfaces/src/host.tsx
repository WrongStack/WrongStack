import {
  type ComponentType,
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
} from 'react';
import type { AtlasHost } from './atlas/atlas-host';
import type { ContextFeed } from './context/context-host';
import type { KanbanHost } from './kanban/kanban-host';
import type { OfficeFeed } from './office/feed-types';
import type { ProviderHost } from './providers/provider-host';
import type { StoryFeed } from './story/story-host';

/**
 * A server frame as a surface handler receives it. Payloads are the engine's own reply shapes;
 * each surface narrows the fields it reads.
 */
export interface SurfaceMessage {
  type: string;
  // biome-ignore lint/suspicious/noExplicitAny: each surface reads its own reply fields.
  payload: any;
}
export interface SurfaceSendOptions {
  echoToChat?: boolean | undefined;
  queueIfDisconnected?: boolean | undefined;
  requestId?: string | undefined;
}
/** The event-bus side of an engine connection: subscribe to a reply type, send a request. */
export interface SurfaceClient {
  on(type: string, handler: (message: SurfaceMessage) => void): () => void;
  findMemoriesForFile(payload: object, options?: SurfaceSendOptions): void;
}
type Payload = object;
/** The SAGE requests the memory surface sends, named as the WebUI's client names them. */
export interface SageSocket {
  client: SurfaceClient;
  listSageMemories(options?: SurfaceSendOptions): void;
  listSageMemoriesPage(params?: Payload, options?: SurfaceSendOptions): void;
  listMemoryCandidates(params?: { includeResolved?: boolean }, options?: SurfaceSendOptions): void;
  searchSageBreakdown(
    params: { query: string; limit?: number; includeStale?: boolean },
    options?: SurfaceSendOptions,
  ): void;
  getSageGraph(
    query: string,
    params?: { maxDepth?: number; limit?: number },
    options?: SurfaceSendOptions,
  ): void;
  updateSage(id: string, patch: Payload, options?: SurfaceSendOptions): void;
  deleteSage(id: string, reason?: string, options?: { neverInject?: boolean }): void;
  rememberSage(opts: Payload, options?: SurfaceSendOptions): void;
  recoverSage(opts: Payload, options?: SurfaceSendOptions): void;
  resolveMemoryCandidate(opts: Payload, options?: SurfaceSendOptions): void;
  sageDoctor(opts?: Payload, options?: SurfaceSendOptions): void;
}
export interface ValidityReview {
  observedRevision: number;
  checkedAt: string;
  applicability: 'unknown';
  checks: Array<{
    path: string;
    text: string;
    status: 'satisfied' | 'not_satisfied' | 'unknown';
    sourceHash?: string | undefined;
  }>;
}
export interface CompanionReview {
  memoryId: string;
  observedRevision: number;
  at: string;
  verdict: string;
  summary: string;
  evidence?: Array<{ path: string; quote: string }> | undefined;
}
export interface ConfirmOptions {
  title: string;
  message?: string | undefined;
  details?: string[] | undefined;
  confirmLabel?: string | undefined;
  cancelLabel?: string | undefined;
  danger?: boolean | undefined;
}

/**
 * What an application provides so the shared surfaces run inside it. The WebUI implements it
 * with its WebSocket client and stores; the desktop with its engine journal. Members named
 * `use…` are React hooks and are called during render.
 */
export interface SurfaceHost {
  useSageSocket(): SageSocket;
  /** The same client outside render (effects and callbacks). */
  getClient(): SurfaceClient;
  /** Whether the engine connection is up; a reconnect reloads what a surface shows. */
  useConnected(): boolean;
  /** Leaves the surface for the conversation, when the application has such a place. */
  useNavigateBack(): (() => void) | undefined;
  /** Keeps a scroll container's position across visits under `key`. */
  useScrollRestore<T extends HTMLElement>(key: string, enabled?: boolean): RefObject<T | null>;
  /** The latest context check of a memory's validity conditions in the active conversation. */
  useValidityReview(memoryId: string): ValidityReview | undefined;
  /** The companion model's latest review of a memory. */
  useCompanionReview(memoryId: string | undefined): CompanionReview | undefined;
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** An engine HTTP request (`/api/…`) on the surface's project. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Asks the agent roster (`agent-roster.list`) and resolves with its reply payload. */
  requestRoster(
    type: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  /** The live data the office surfaces render; hosts without an office leave it out. */
  office?: OfficeFeed | undefined;
  /** What the Kanban surfaces need; hosts without a board leave it out. */
  kanban?: KanbanHost | undefined;
  /** What the application adds to the Code Atlas (its code-assist panel, views and evidence). */
  atlas?: AtlasHost | undefined;
  /** What the Session Story reads; hosts without one leave it out. */
  story?: StoryFeed | undefined;
  /** What the context dashboard reads; hosts without one leave it out. */
  context?: ContextFeed | undefined;
  /** What the provider test and plan-quota pages read; hosts without them leave it out. */
  providers?: ProviderHost | undefined;
  /** Renders a message's markdown the way the application renders its own messages. */
  Markdown?: ComponentType<{ children: string }> | undefined;
}

let currentHost: SurfaceHost | null = null;
/** The host used when no `SurfaceHostProvider` is mounted (the WebUI registers its own). */
export function setDefaultSurfaceHost(host: SurfaceHost): void {
  currentHost = host;
}
const HostContext = createContext<SurfaceHost | null>(null);

/** Provides a host to the surfaces below; it also serves the surfaces' plain functions. */
export function SurfaceHostProvider({
  host,
  children,
}: {
  host: SurfaceHost;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    const previous = currentHost;
    currentHost = host;
    return () => {
      if (currentHost === host) currentHost = previous;
    };
  }, [host]);
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}
export function useSurfaceHost(): SurfaceHost {
  const host = useContext(HostContext) ?? currentHost;
  if (!host) throw new Error('A shared surface rendered without a SurfaceHost.');
  return host;
}
function activeHost(): SurfaceHost {
  if (!currentHost) throw new Error('A shared surface ran without a SurfaceHost.');
  return currentHost;
}
/** `fetch` for the surfaces' plain request helpers, routed through the active host. */
export function surfaceFetch(path: string, init?: RequestInit): Promise<Response> {
  return activeHost().fetch(path, init);
}
/** `confirm` for callbacks, routed through the active host. */
export function surfaceConfirm(options: ConfirmOptions): Promise<boolean> {
  return activeHost().confirm(options);
}
/** The engine client for effects, routed through the active host. */
export function surfaceClient(): SurfaceClient {
  return activeHost().getClient();
}
/** An agent roster request, routed through the active host. */
export function surfaceRoster(
  type: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) {
  return activeHost().requestRoster(type, payload, signal);
}
