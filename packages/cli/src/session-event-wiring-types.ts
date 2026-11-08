import type { ChronicleEventSink } from '@wrongstack/chronicle';
import type { EventBus } from '@wrongstack/contracts/kernel';
import type { SessionEventBridge } from '@wrongstack/core/storage';

// ── Types ─────────────────────────────────────────────────────────────────

export interface ErrorEntry {
  ts: string;
  phase: string;
  code: string;
  message: string;
}

export interface WireSessionEventsDeps {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic EventBus dispatch
  evOn: (event: string, handler: (...args: any[]) => void) => void;
  /** Concrete bus is required for Chronicle lifecycle subscriptions. */
  events?: EventBus | undefined;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  session: { id: string };
  sessionRef: { current?: { id: string } | undefined };
  wpaths: {
    globalRoot: string;
    projectSlug: string;
    projectHash?: string | undefined;
    projectDir?: string | undefined;
  };
  projectRoot: string;
  renderer?: { writeInfo?: (msg: string) => void };
  tuiOwnsScreen?: boolean;
}

export interface WireSessionEventsResult {
  errorRing: ErrorEntry[];
  sessionBridge: SessionEventBridge;
  appendSessionEvent: (
    sessionId: string | undefined,
    event: Parameters<SessionEventBridge['append']>[0],
  ) => void;
  chronicleJournal?: ChronicleEventSink | undefined;
  disposeChronicle: () => Promise<void>;
}
