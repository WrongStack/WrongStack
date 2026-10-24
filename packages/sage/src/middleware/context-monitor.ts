import type { EventBus, Middleware } from '@wrongstack/contracts/kernel';
import type { Message, Request } from '@wrongstack/contracts/types';
import type { InjectionTracker } from './injection-tracker.js';

export interface SageContextMonitorOptions {
  tracker: InjectionTracker;
  events: EventBus;
  getSessionId?: (() => string | undefined) | undefined;
  now?: (() => Date) | undefined;
  /**
   * Usefulness sink. When set, the monitor credits `recordUse` for every
   * memory the latest assistant message references — but only memories that
   * were in the provider request which produced that message.
   *
   * The monitor is the right owner because it is installed on every host and
   * runs on every provider request. Crediting used to live only in the
   * opt-in turn-context middleware, so on a default install `useCount` never
   * moved: every injected memory looked unused, collected the unused penalty
   * after three injections and became a hygiene archive candidate, while the
   * genuinely useful ones were indistinguishable from noise.
   */
  memory?:
    | {
        recordUse?(
          memoryIds: string[],
          source: string,
          sessionId?: string | undefined,
        ): void | Promise<void>;
      }
    | undefined;
}

/** Sessions whose last-scanned assistant message is remembered. */
const MAX_TRACKED_SESSIONS = 256;

/** Emit an exact memory-presence snapshot for every provider-bound request. */
export function createSageContextMonitorMiddleware(
  opts: SageContextMonitorOptions,
): Middleware<Request> {
  const lastAssistantBySession = new Map<string, string>();
  return {
    name: 'sage.context-monitor',
    owner: 'sage',
    async handler(request, next) {
      const now = opts.now?.() ?? new Date();
      const sessionId = opts.getSessionId?.();
      // What the model could see when it wrote its latest message is the
      // PREVIOUS snapshot — read it before this request replaces it.
      const previouslyActive = opts.tracker.activeMemoryIds(sessionId);
      const snapshot = opts.tracker.snapshotContextParts(
        requestTextParts(request),
        sessionId,
        now.getTime(),
      );
      opts.events.emit('memory.context_snapshot', {
        at: now.toISOString(),
        ...snapshot,
        reason: 'provider_request',
        sessionId,
      });
      if (opts.memory?.recordUse) {
        await creditAssistantUses(request, sessionId, now.getTime(), previouslyActive);
      }
      return next(request);
    },
  };

  async function creditAssistantUses(
    request: Request,
    sessionId: string | undefined,
    now: number,
    previouslyActive: ReadonlySet<string>,
  ): Promise<void> {
    try {
      const text = lastAssistantText(request.messages);
      if (!text) return;
      // Every request in a tool loop re-sends the same latest assistant
      // message. Scan each message once; consume-once alone would still let a
      // memory injected later in the loop match the older message.
      const key = sessionId ?? '<no-session>';
      const fingerprint = `${text.length}:${fnv1a(text)}`;
      if (lastAssistantBySession.get(key) === fingerprint) return;
      lastAssistantBySession.delete(key);
      lastAssistantBySession.set(key, fingerprint);
      if (lastAssistantBySession.size > MAX_TRACKED_SESSIONS) {
        const oldest = lastAssistantBySession.keys().next().value;
        if (oldest !== undefined) lastAssistantBySession.delete(oldest);
      }
      if (previouslyActive.size === 0) return;
      const used = opts.tracker.consumeMatches(text, now, sessionId, {
        onlyIds: previouslyActive,
      });
      if (used.length === 0) return;
      await opts.memory?.recordUse?.(used, 'assistant_reference', sessionId);
    } catch {
      // Usefulness counters are advisory; a store hiccup must never fail the
      // provider request.
    }
  }
}

function* requestTextParts(request: Request): Iterable<string> {
  for (const block of request.system ?? []) yield block.text;
  for (const message of request.messages) yield* messageText(message);
}

function messageText(message: Message): string[] {
  if (typeof message.content === 'string') return [message.content];
  return message.content.flatMap((block) => {
    if (block.type === 'text') return [block.text];
    if (block.type === 'tool_result') return [block.content];
    return [];
  });
}

function lastAssistantText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(' ');
    // Only the latest assistant message counts, even when it carries no text
    // (a pure tool_use step): an older message predates later injections.
    return text.trim();
  }
  return '';
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
