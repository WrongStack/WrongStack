import type { EventBus } from '@wrongstack/contracts/kernel';
import type { ChronicleEventJournalHandle, ChronicleEventSink } from '@wrongstack/core/chronicle';
import { createChronicleEventJournal } from '@wrongstack/core/chronicle';
import type { SessionEventBridge } from '@wrongstack/core/storage';
import { toErrorMessage } from '@wrongstack/core/utils';

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

// ── Chronicle retention ───────────────────────────────────────────────────

const DEFAULT_CHRONICLE_RETENTION_DAYS = 7;

const MIN_CHRONICLE_RETENTION_DAYS = 7;

/** `0` disables auto-purge; positive values are floored at 7 days so a
 *  project-committed config cannot flush recent evidence. */
export function resolveChronicleRetentionDays(config: Record<string, unknown>): number {
  const raw = (config.chronicle as { retentionDays?: unknown } | undefined)?.retentionDays;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_CHRONICLE_RETENTION_DAYS;
  if (raw <= 0) return 0;
  return Math.max(MIN_CHRONICLE_RETENTION_DAYS, raw);
}

/** Read a positive numeric `chronicle.*` knob, or undefined to keep the default. */
export function chronicleLimit(config: Record<string, unknown>, key: string): number | undefined {
  const raw = (config.chronicle as Record<string, unknown> | undefined)?.[key];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/**
 * Open the Chronicle journal, or give up on telemetry for this session.
 *
 * `createChronicleEventJournal` fails closed: rather than quietly handing this
 * process its own hash chain when the daemon build cannot be located, it
 * raises. Chronicle is observability, though — losing it must never stop a
 * user from working. So the failure is absorbed here, once, and reported.
 *
 * Note what is *not* done: no silent retry into an inline journal. Telemetry is
 * either recorded by the project's single owner or not recorded at all, and the
 * operator is told which.
 */
export function tryCreateChronicleJournal(
  options: Parameters<typeof createChronicleEventJournal>[0],
): ChronicleEventJournalHandle | undefined {
  try {
    return createChronicleEventJournal(options);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'chronicle.disabled',
        reason: toErrorMessage(error),
        timestamp: new Date().toISOString(),
      }),
    );
    return undefined;
  }
}
