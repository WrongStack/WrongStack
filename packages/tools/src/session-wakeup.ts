/**
 * `session_wakeup` — a timer the leader sets for itself.
 *
 * "Check the deploy in ten minutes", "look at CI every five minutes": the
 * model schedules a prompt, ends its turn, and the prompt comes back as a
 * `[RUNTIME NOTICE]` when the timer fires. A running loop receives it at the
 * next iteration; an idle session is woken for it by the auto-wake controller
 * (notice-only wakes have their own budget, and stop after a chain of woken
 * turns without user input). Without this the only way to wait was to sleep
 * inside a shell call, which blocks the whole turn.
 *
 * Session-only and in-process: timers are unref'd (a pending wakeup never
 * keeps the CLI alive), are keyed to the scheduling session, and die with the
 * process. Recurring wakeups expire after {@link RECURRING_MAX_LIFETIME_MS}.
 */

import type { Tool } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import {
  enqueueRuntimeNotice,
  leaderDeliveryHub,
  resolveRuntimeNoticeTarget,
} from '@wrongstack/coordination';
import { formatNoticeDuration } from './background-exit-notice.js';

export const WAKEUP_MIN_DELAY_S = 5;
export const WAKEUP_MAX_DELAY_S = 86_400;
export const WAKEUP_MIN_EVERY_S = 30;
export const WAKEUP_MAX_PER_SESSION = 10;
export const WAKEUP_PROMPT_MAX_CHARS = 2_000;
export const RECURRING_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface SessionWakeupInput {
  action?: 'schedule' | 'list' | 'cancel' | undefined;
  delay_s?: number | undefined;
  every_s?: number | undefined;
  prompt?: string | undefined;
  id?: string | undefined;
}

export interface SessionWakeupView {
  id: string;
  prompt: string;
  next_at: string;
  in_s: number;
  every_s?: number | undefined;
  fires: number;
  last_fired_at?: string | undefined;
  expires_at?: string | undefined;
}

/** What host surfaces hear: the set changed, or one wakeup fired. */
export type SessionWakeupChange =
  | { kind: 'changed' }
  | { kind: 'fired'; id: string; prompt: string; fires: number; ts: string };

export interface SessionWakeupOutput {
  ok: true;
  message: string;
  wakeup?: SessionWakeupView | undefined;
  wakeups?: SessionWakeupView[] | undefined;
  cancelled?: string[] | undefined;
}

interface Wakeup {
  id: string;
  sessionId: string;
  prompt: string;
  createdAt: number;
  nextAt: number;
  everyMs?: number | undefined;
  expiresAt?: number | undefined;
  fires: number;
  lastFiredAt?: number | undefined;
  /** Fires skipped because the previous notice was still undelivered. */
  coalesced: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const wakeups = new Map<string, Wakeup>();
let nextId = 1;
const changeListeners = new Set<(change: SessionWakeupChange) => void>();

function emitChange(change: SessionWakeupChange): void {
  for (const listener of changeListeners) {
    try {
      listener(change);
    } catch {
      // A surface listener must never break a timer.
    }
  }
}

/** Subscribe to wakeup changes (UI panels). Returns an unsubscribe. */
export function onSessionWakeupsChanged(
  listener: (change: SessionWakeupChange) => void,
): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

function view(w: Wakeup, now = Date.now()): SessionWakeupView {
  return {
    id: w.id,
    prompt: w.prompt,
    next_at: new Date(w.nextAt).toISOString(),
    in_s: Math.max(0, Math.round((w.nextAt - now) / 1000)),
    ...(w.everyMs ? { every_s: Math.round(w.everyMs / 1000) } : {}),
    fires: w.fires,
    ...(w.lastFiredAt ? { last_fired_at: new Date(w.lastFiredAt).toISOString() } : {}),
    ...(w.expiresAt ? { expires_at: new Date(w.expiresAt).toISOString() } : {}),
  };
}

function clear(w: Wakeup): void {
  if (w.timer) clearTimeout(w.timer);
  w.timer = null;
  if (wakeups.delete(w.id)) emitChange({ kind: 'changed' });
}

function arm(w: Wakeup): void {
  const timer = setTimeout(() => fire(w), Math.max(0, w.nextAt - Date.now()));
  timer.unref?.();
  w.timer = timer;
}

function noticePending(w: Wakeup): boolean {
  return leaderDeliveryHub
    .peek(w.sessionId)
    .some(
      (d) =>
        d.kind === 'runtime_notice' && d.payload.source === 'timer' && d.payload.handle === w.id,
    );
}

function fire(w: Wakeup): void {
  w.timer = null;
  if (wakeups.get(w.id) !== w) return;
  const now = Date.now();
  const final = !w.everyMs || (w.expiresAt !== undefined && now + w.everyMs > w.expiresAt);
  // A recurring wakeup whose last notice was not read yet (session busy for
  // a long run, or not displayed) does not stack another one on top.
  if (w.everyMs && !final && noticePending(w)) {
    w.coalesced += 1;
  } else {
    w.fires += 1;
    w.lastFiredAt = now;
    const lines = [`prompt: ${w.prompt}`];
    if (w.coalesced > 0) {
      lines.push(`(${w.coalesced} earlier run(s) skipped while the previous notice was unread)`);
      w.coalesced = 0;
    }
    if (w.everyMs && !final) {
      lines.push(
        `Recurring every ${formatNoticeDuration(w.everyMs)}; next in ${formatNoticeDuration(w.everyMs)}. Stop it with session_wakeup action=cancel id=${w.id} once it is no longer needed.`,
      );
    } else if (w.everyMs) {
      lines.push(
        'This was the final run: recurring wakeups expire after 24h. Schedule a new one if still needed.',
      );
    }
    try {
      enqueueRuntimeNotice(w.sessionId, {
        source: 'timer',
        handle: w.id,
        seq: w.fires,
        title: `session_wakeup ${w.id} fired${w.everyMs ? ` (run ${w.fires})` : ''}, scheduled ${formatNoticeDuration(now - w.createdAt)} ago.`,
        body: lines.join('\n'),
      });
    } catch {
      // Delivery is best-effort; a broken hub must not crash the timer.
    }
    emitChange({
      kind: 'fired',
      id: w.id,
      prompt: w.prompt,
      fires: w.fires,
      ts: new Date(now).toISOString(),
    });
  }
  if (final) {
    clear(w);
    return;
  }
  w.nextAt = now + (w.everyMs ?? 0);
  arm(w);
  emitChange({ kind: 'changed' });
}

function finiteSeconds(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ToolValidationError({ message: `${field} must be a number of seconds`, field });
  }
  return n;
}

function sessionWakeups(sessionId: string): Wakeup[] {
  return [...wakeups.values()]
    .filter((w) => w.sessionId === sessionId)
    .sort((a, b) => a.nextAt - b.nextAt);
}

/** Active wakeups, optionally for one session (UI panels, diagnostics). */
export function listSessionWakeups(sessionId?: string): SessionWakeupView[] {
  const now = Date.now();
  return [...wakeups.values()]
    .filter((w) => sessionId === undefined || w.sessionId === sessionId)
    .sort((a, b) => a.nextAt - b.nextAt)
    .map((w) => view(w, now));
}

/** Cancel one wakeup by id from a host surface. True when one was removed. */
export function cancelSessionWakeup(id: string): boolean {
  const w = wakeups.get(id);
  if (!w) return false;
  clear(w);
  return true;
}

/**
 * Test helper: drop every wakeup. Ids stay monotonic on purpose — the
 * delivery hub dedupes on `timer:<id>#<n>` for the life of the process, so a
 * reused id would have its notices silently dropped.
 */
export function _resetSessionWakeups(): void {
  for (const w of [...wakeups.values()]) clear(w);
}

function requireSession(ctx: unknown): string {
  const sessionId = resolveRuntimeNoticeTarget(ctx);
  if (!sessionId) {
    throw new Error(
      'session_wakeup: only the session leader receives wakeups. A sub-agent should finish its task and report back instead of waiting.',
    );
  }
  return sessionId;
}

export const sessionWakeupTool: Tool<SessionWakeupInput, SessionWakeupOutput> = {
  name: 'session_wakeup',
  category: 'Session',
  description:
    'Schedule a prompt to come back to you later as a [RUNTIME NOTICE]: once after delay_s, or every every_s. An idle session is woken for it. Use instead of sleeping or polling while you wait on something slow (CI, a deploy, a long build).',
  usageHint:
    '- action=schedule with `prompt` (what to do when it fires) and `delay_s` (one-shot) and/or `every_s` (recurring, >= 30s, expires after 24h). End your turn afterwards; do not sleep or poll.\n' +
    '- action=list shows this session’s wakeups; action=cancel with `id` (or id="all") removes them. Cancel a recurring wakeup as soon as it is no longer needed.\n' +
    '- Pick the delay from how fast the thing you wait on changes: a CI run that takes ~8 minutes deserves one ~480s wakeup, not eight 60s ones.\n' +
    '- To react to output lines of a running command instead of a clock, use process_watch. Background bash/pwsh processes already report their own exit.',
  permission: 'auto',
  mutating: false,
  riskTier: 'safe',
  icon: 'plan',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['schedule', 'list', 'cancel'],
        description: 'Default schedule.',
      },
      prompt: {
        type: 'string',
        description: `schedule: what you should do when it fires (max ${WAKEUP_PROMPT_MAX_CHARS} chars).`,
      },
      delay_s: {
        type: 'number',
        description: `schedule: seconds until it fires (${WAKEUP_MIN_DELAY_S}..${WAKEUP_MAX_DELAY_S}). Defaults to every_s for a recurring wakeup.`,
      },
      every_s: {
        type: 'number',
        description: `schedule: repeat interval in seconds (${WAKEUP_MIN_EVERY_S}..${WAKEUP_MAX_DELAY_S}). Omit for a one-shot wakeup.`,
      },
      id: { type: 'string', description: 'cancel: the wakeup id, or "all".' },
    },
  },
  async execute(input, ctx) {
    return runSessionWakeup(input, ctx);
  },
};

async function runSessionWakeup(
  input: SessionWakeupInput,
  ctx: unknown,
): Promise<SessionWakeupOutput> {
  const action = input?.action ?? 'schedule';
  const sessionId = requireSession(ctx);

  if (action === 'list') {
    const items = sessionWakeups(sessionId).map((w) => view(w));
    return {
      ok: true,
      message:
        items.length === 0 ? 'No wakeups scheduled.' : `${items.length} wakeup(s) scheduled.`,
      wakeups: items,
    };
  }

  if (action === 'cancel') {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id)
      throw new ToolValidationError({ message: 'cancel requires id (or "all")', field: 'id' });
    const targets =
      id === 'all'
        ? sessionWakeups(sessionId)
        : [wakeups.get(id)].filter((w) => w?.sessionId === sessionId);
    if (targets.length === 0) {
      if (id === 'all') return { ok: true, message: 'No wakeups to cancel.', cancelled: [] };
      throw new Error(`session_wakeup: no wakeup '${id}' in this session (see action=list).`);
    }
    for (const w of targets) if (w) clear(w);
    const cancelled = targets.flatMap((w) => (w ? [w.id] : []));
    return { ok: true, message: `Cancelled ${cancelled.join(', ')}.`, cancelled };
  }

  if (action !== 'schedule') {
    throw new ToolValidationError({
      message: `unknown action '${String(action)}'`,
      field: 'action',
    });
  }
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) {
    throw new ToolValidationError({
      message: 'schedule requires prompt: what you should do when the wakeup fires',
      field: 'prompt',
    });
  }
  if (prompt.length > WAKEUP_PROMPT_MAX_CHARS) {
    throw new ToolValidationError({
      message: `prompt is longer than ${WAKEUP_PROMPT_MAX_CHARS} characters`,
      field: 'prompt',
    });
  }
  const everyS = finiteSeconds(input.every_s, 'every_s');
  const delayS = finiteSeconds(input.delay_s, 'delay_s') ?? everyS;
  if (delayS === undefined) {
    throw new ToolValidationError({
      message: 'schedule requires delay_s or every_s',
      field: 'delay_s',
    });
  }
  if (delayS < WAKEUP_MIN_DELAY_S || delayS > WAKEUP_MAX_DELAY_S) {
    throw new ToolValidationError({
      message: `delay_s must be between ${WAKEUP_MIN_DELAY_S} and ${WAKEUP_MAX_DELAY_S}`,
      field: 'delay_s',
    });
  }
  if (everyS !== undefined && (everyS < WAKEUP_MIN_EVERY_S || everyS > WAKEUP_MAX_DELAY_S)) {
    throw new ToolValidationError({
      message: `every_s must be between ${WAKEUP_MIN_EVERY_S} and ${WAKEUP_MAX_DELAY_S}`,
      field: 'every_s',
    });
  }
  if (sessionWakeups(sessionId).length >= WAKEUP_MAX_PER_SESSION) {
    throw new Error(
      `session_wakeup: this session already has ${WAKEUP_MAX_PER_SESSION} wakeups; cancel one first (action=list).`,
    );
  }

  const now = Date.now();
  const w: Wakeup = {
    id: `wk-${nextId++}`,
    sessionId,
    prompt,
    createdAt: now,
    nextAt: now + Math.round(delayS * 1000),
    ...(everyS !== undefined
      ? { everyMs: Math.round(everyS * 1000), expiresAt: now + RECURRING_MAX_LIFETIME_MS }
      : {}),
    fires: 0,
    coalesced: 0,
    timer: null,
  };
  wakeups.set(w.id, w);
  arm(w);
  emitChange({ kind: 'changed' });
  const when = formatNoticeDuration(w.nextAt - now);
  return {
    ok: true,
    message:
      `Scheduled ${w.id}: fires in ${when}${w.everyMs ? `, then every ${formatNoticeDuration(w.everyMs)} (expires after 24h)` : ''}. ` +
      'The prompt comes back as a [RUNTIME NOTICE]; an idle session is woken for it. End your turn now instead of sleeping or polling.',
    wakeup: view(w, now),
  };
}
