import { getWSClient } from '@/lib/ws-client';
import type { WrongStackWebSocketClient } from '@/lib/ws-client';
import { messageSessionId } from '@/lib/ws-client-utils';
import type { WSServerMessage } from '@/types';
import { useEffect, useRef } from 'react';

/**
 * Lane-aware single-message subscription hook (B-03).
 *
 * The earlier design let every component that needed a server message reach
 * into `getWSClient().on(type, handler)` directly — 118 ad-hoc call sites
 * across the codebase. Each of those sites re-implements the same two
 * concerns, both of which are easy to get wrong and almost impossible to
 * audit in isolation:
 *
 *   1. teardown — forgetting to call the returned `off()` (or calling it
 *      against a stale closure) leaves a stale listener on the socket that
 *      keeps dispatching into an unmounted component;
 *
 *   2. lane filtering — a multi-tab window has up to MAX_LANES tabs sharing
 *      one WS connection, and a message addressed to tab 2 must not be
 *      acted on by tab 1's listener. Some sites filter on
 *      `payload.sessionId`, some on `isActiveSessionMessage`, and many
 *      forget to filter at all (every reply lands on every tab).
 *
 * `useServerMessage` collapses both: it registers exactly once, cleans up on
 * unmount, and drops messages whose `payload.sessionId` doesn't match the
 * `sessionId` passed in. Filtering is OPT-IN: a caller that passes no
 * `sessionId` receives every frame of that type, exactly as a raw `ws.on`
 * would. Pass the lane you care about whenever the state you update is
 * tab-local.
 *
 * Typing follows the underlying `ws.on` narrowing — pass a literal `type`
 * and the handler receives the matching union member of `WSServerMessage`,
 * not the bare envelope.
 *
 * The handler is captured in a ref so re-renders don't churn the WS
 * subscription. Pass `deps` when the handler closes over reactive state
 * that should be fresh inside the handler (same contract as `useEffect`).
 *
 * Example migration of the three ad-hoc `context.editor.*` subscriptions
 * inside `ContextWindowEditor.tsx`:
 *
 *   useServerMessage('context.editor.snapshot', (msg) => {
 *     store.getState().loadSnapshot(msg.payload);
 *   }, { sessionId: askedFor, deps: [store] });
 */
export interface UseServerMessageOptions {
  /**
   * If provided, the handler runs ONLY when the inbound message's
   * `payload.sessionId` matches this value (or when the message has no
   * sessionId stamp at all — boot-time broadcasts, project-wide events).
   * If omitted, NO lane filter is applied and the handler sees every frame
   * of this type, including replies addressed to another tab. Accepts
   * `null` for sources that may yield a nullable pointer (Zustand
   * selectors, etc.) — it is normalized to "no pin".
   */
  sessionId?: string | null | undefined;
  /**
   * Re-subscribe when these change. Same contract as `useEffect`. Defaults
   * to `[]` — the subscription is mounted once.
   */
  deps?: ReadonlyArray<unknown>;
  /**
   * When `false`, the hook stays registered (so the deps contract is not
   * violated) but the WS subscription is NOT installed — both the initial
   * register and any dep-driven re-register are skipped. Defaults to
   * `true`. Mirrors the `active` / `enabled` flag most consumers want to
   * gate polling loops on without paying the cleanup + re-register cost.
   */
  enabled?: boolean;
}

export function useServerMessage<K extends WSServerMessage['type']>(
  type: K,
  handler: (msg: Extract<WSServerMessage, { type: K }>) => void,
  options: UseServerMessageOptions = {},
): void {
  // Normalize null → undefined so the filter check (`target !== undefined`)
  // below treats "no pin" uniformly regardless of whether the caller
  // passed `undefined` explicitly or a Zustand selector returned `null`.
  const { sessionId: rawSessionId, deps = [], enabled = true } = options;
  const sessionId = rawSessionId ?? undefined;

  // Latest handler/sessionId in refs so the effect can stay stable while the
  // values they reference update on every render.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    if (!enabled) return;
    const client: WrongStackWebSocketClient | null = getWSClient();
    if (!client) return;

    const off = client.on(type, (msg) => {
      // Built-in lane filter: drop messages whose `payload.sessionId` is
      // explicitly addressed to a different tab. The check is intentionally
      // permissive when `sessionId` is unset (caller didn't pin) — see the
      // hook docstring for the multi-tab rationale.
      const target = sessionIdRef.current;
      if (target !== undefined) {
        const replyFor = messageSessionId(msg as WSServerMessage);
        if (replyFor && replyFor !== target) return;
      }
      handlerRef.current(msg);
    });

    return () => {
      try {
        off();
      } catch {
        // best-effort — a stale off() after socket teardown is harmless
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);
}
