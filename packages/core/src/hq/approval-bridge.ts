/**
 * Approval mirroring — puts the permission prompts raised by TUI, WebUI and
 * SimpleUI on the HQ dashboard, and lets an operator answer them from there.
 *
 * All three surfaces converge on ONE emission point: `waitForConfirm()` in
 * `core/agent-tools.ts` emits `tool.confirm_needed` carrying an idempotent
 * resolver. The TUI subscribes directly; WebUI and SimpleUI subscribe through
 * their shared backend and relay over their own socket. So a single listener
 * on the local EventBus mirrors every surface — there is deliberately no
 * per-host copy of this logic to drift.
 *
 * Two pieces, separated on purpose:
 *
 *  - {@link createApprovalRegistry} holds the live prompts and their
 *    resolvers. It lives for the whole process, independent of whether HQ is
 *    currently connected, because the resolver is the only thing that can
 *    answer a prompt and dropping it on a reconnect would strand the run.
 *  - {@link startApprovalTelemetryBridge} publishes what the registry holds.
 *    It is started and stopped with each HQ connection, and REPLAYS every
 *    outstanding prompt on start so a dashboard opened (or reconnected)
 *    mid-prompt sees the live set rather than an empty board.
 *
 * HQ is a mirror, never the sole approver. The registry marks itself a
 * passive observer ({@link markConfirmObserver}) so the headless auto-deny
 * guard in `waitForConfirm` still fires when HQ is the only listener — being
 * connected to a dashboard must not convert a CI run's instant denial into a
 * two-minute wait for a human who is not there.
 *
 * @module hq/approval-bridge
 */

import { markConfirmObserver } from '../core/confirm-observers.js';
import { markUserInputObserver } from '../core/user-input-observers.js';
import type { EventBus } from '../kernel/events.js';
import type { UserInputRequest, UserInputResponse } from '../types/user-input.js';
import { type BridgeContextOptions, createBridgeContext } from './bridge-context.js';
import type { HqApprovalRequestedPayload, HqApprovalResolvedPayload } from './protocol.js';
import { summarizeHqToolArgs } from './redaction.js';

/** The four answers an operator can give. `abort` is produced by the run, never sent. */
export type HqApprovalDecision = 'yes' | 'no' | 'always' | 'deny';

/** One prompt currently on screen, with the resolver that can settle it. */
export interface PendingApproval {
  toolUseId: string;
  toolName: string;
  sessionId?: string | undefined;
  /**
   * Epoch ms after which this entry stops being pending. A registered entry
   * cannot outlive it — that is what keeps a stale card off the dashboard when
   * a resolved envelope is missed. For executor-raised prompts this is the
   * Brain arbiter's deadline; for a terminal prompt (which has no timeout) it
   * is a heartbeat window the host pushes forward via {@link ApprovalRegistry.renew}.
   *
   * Mutable for exactly that renewal; nothing else writes it.
   */
  deadlineAt: number;
  /** Raw tool input, redacted only at publish time (never stored redacted — the local surfaces need the truth). */
  input: unknown;
  suggestedPattern: string;
  riskTier?: 'safe' | 'standard' | 'destructive' | undefined;
  decisionSource?: string | undefined;
  boundaryReason?: string | undefined;
  writeTargets?: readonly string[] | undefined;
  destructive: boolean;
  resolve: (decision: HqApprovalDecision) => void;
}
export interface PendingHqUserInput {
  request: UserInputRequest;
  sessionId?: string | undefined;
  resolve: (response: UserInputResponse) => void;
}

export interface ApprovalRegistry {
  /** Every prompt still awaiting an answer, oldest first. */
  list(): readonly PendingApproval[];
  listUserInputs?(): readonly PendingHqUserInput[];
  resolveUserInput?(
    requestId: string,
    response: UserInputResponse,
    expectSessionId?: string | undefined,
  ): boolean;
  /**
   * Answer a prompt on behalf of a remote operator.
   *
   * Returns `false` when the prompt is unknown — already answered on the
   * machine, aborted, or timed out. The caller MUST report that back rather
   * than treating it as success: the operator needs to learn their answer did
   * not apply, not assume it did.
   *
   * `expectSessionId`, when given, must match the prompt's own session. A
   * command names the session the operator picked in HQ; applying it to a
   * different session's prompt would answer a conversation they were not
   * looking at.
   */
  resolve(
    toolUseId: string,
    decision: HqApprovalDecision,
    expectSessionId?: string | undefined,
  ): boolean;
  /**
   * Add a prompt that did NOT come from `tool.confirm_needed`.
   *
   * The plain REPL asks through the permission policy's own prompt delegate,
   * which never reaches the executor's confirm path and so raises no event.
   * Its prompt is mirrored by registering here instead.
   *
   * Returns a disposer that removes the entry and announces it as resolved —
   * call it when the prompt is answered at the terminal, so the HQ card goes
   * away instead of waiting out its deadline.
   */
  register(approval: PendingApproval): (decision?: HqApprovalResolvedPayload['decision']) => void;
  /**
   * Push a registered prompt's deadline forward and re-announce it.
   *
   * A terminal prompt has no timeout — it waits for a keypress however long
   * that takes — but a mirrored card MUST expire, because "pending cannot
   * outlive its deadline" is the only thing keeping a stale card off the
   * dashboard when a resolved envelope is missed or a host dies mid-prompt.
   * Renewing on a heartbeat keeps both true: the card lives while the process
   * says it is still asking, and dies within one window when it stops.
   *
   * Returns false when the entry is gone (already answered).
   */
  renew(toolUseId: string, deadlineAt: number): boolean;
  /** Stop listening and forget every entry. Does NOT answer the outstanding prompts. */
  dispose(): void;
  /** Subscribe to registry changes — used by the HQ bridge to publish. */
  onChange(listener: (change: ApprovalChange) => void): () => void;
}

export type ApprovalChange =
  | { kind: 'requested'; approval: PendingApproval }
  | {
      kind: 'resolved';
      toolUseId: string;
      toolName: string;
      sessionId?: string | undefined;
      decision: HqApprovalResolvedPayload['decision'];
      source: HqApprovalResolvedPayload['source'];
      rationale?: string | undefined;
    }
  | { kind: 'input_requested'; input: PendingHqUserInput }
  | {
      kind: 'input_resolved';
      requestId: string;
      sessionId?: string | undefined;
      response: UserInputResponse;
      source: 'user' | 'abort';
    };

interface ConfirmNeededEvent {
  sessionId?: string | undefined;
  tool: { name: string };
  input: unknown;
  toolUseId: string;
  suggestedPattern: string;
  decisionSource?: string | undefined;
  riskTier?: 'safe' | 'standard' | 'destructive' | undefined;
  writeTargets?: string[] | undefined;
  boundaryReason?: string | undefined;
  deadlineAt: number;
  resolve: (decision: HqApprovalDecision) => void;
}

interface ConfirmResolvedEvent {
  sessionId?: string | undefined;
  toolUseId: string;
  toolName: string;
  decision: HqApprovalResolvedPayload['decision'];
  source: HqApprovalResolvedPayload['source'];
  rationale?: string | undefined;
}

/**
 * Is this the kind of call a surface flags in red? Computed once here so the
 * dashboard, the TUI dialog and the WebUI modal cannot disagree about it.
 * Mirrors the TUI's own test in `use-provider-event-bridge.ts`.
 */
function isDestructive(e: {
  riskTier?: string | undefined;
  decisionSource?: string | undefined;
}): boolean {
  return e.riskTier === 'destructive' || e.decisionSource === 'yolo_destructive';
}

export function createApprovalRegistry(events: EventBus): ApprovalRegistry {
  const pending = new Map<string, PendingApproval>();
  const pendingInputs = new Map<string, PendingHqUserInput>();
  const listeners = new Set<(change: ApprovalChange) => void>();
  // Declared BEFORE subscribing: the guard in `waitForConfirm` reads this
  // count, and a window where the listener exists but is not yet declared
  // passive is a window where a headless run waits instead of denying.
  const releaseObserver = markConfirmObserver();
  const releaseUserInputObserver = markUserInputObserver();

  const notify = (change: ApprovalChange): void => {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch {
        /* a broken subscriber must not break the approval path */
      }
    }
  };

  const offNeeded = events.on('tool.confirm_needed', (raw: unknown) => {
    const e = raw as ConfirmNeededEvent;
    const approval: PendingApproval = {
      toolUseId: e.toolUseId,
      toolName: e.tool?.name ?? 'unknown',
      sessionId: e.sessionId,
      deadlineAt: e.deadlineAt,
      input: e.input,
      suggestedPattern: e.suggestedPattern,
      riskTier: e.riskTier,
      decisionSource: e.decisionSource,
      boundaryReason: e.boundaryReason,
      writeTargets: e.writeTargets,
      destructive: isDestructive(e),
      resolve: e.resolve,
    };
    pending.set(approval.toolUseId, approval);
    notify({ kind: 'requested', approval });
  });

  const offResolved = events.on('tool.confirm_resolved', (raw: unknown) => {
    const e = raw as ConfirmResolvedEvent;
    const held = pending.get(e.toolUseId);
    pending.delete(e.toolUseId);
    notify({
      kind: 'resolved',
      toolUseId: e.toolUseId,
      toolName: e.toolName,
      sessionId: e.sessionId ?? held?.sessionId,
      decision: e.decision,
      source: e.source,
      rationale: e.rationale,
    });
  });
  const offInputRequested = events.on('user.input_requested', (event) => {
    const input = { request: event.request, sessionId: event.sessionId, resolve: event.resolve };
    pendingInputs.set(event.request.id, input);
    notify({ kind: 'input_requested', input });
  });
  const offInputResolved = events.on('user.input_resolved', (event) => {
    const held = pendingInputs.get(event.requestId);
    pendingInputs.delete(event.requestId);
    notify({
      kind: 'input_resolved',
      requestId: event.requestId,
      sessionId: event.sessionId ?? held?.sessionId,
      response: event.response,
      source: event.source,
    });
  });

  /**
   * A prompt past its deadline is settled by definition — the Brain arbiter
   * has taken it — so it is never returned or resolvable. Swept lazily on
   * read rather than on a timer: the set is tiny and bounded by how many
   * prompts a human could have open, and a timer would be one more thing to
   * tear down.
   */
  const sweep = (): void => {
    const now = Date.now();
    for (const [id, approval] of pending) {
      if (approval.deadlineAt <= now) pending.delete(id);
    }
  };

  return {
    list() {
      sweep();
      return [...pending.values()].sort((a, b) => a.deadlineAt - b.deadlineAt);
    },
    listUserInputs() {
      return [...pendingInputs.values()];
    },
    resolveUserInput(requestId, response, expectSessionId) {
      const input = pendingInputs.get(requestId);
      if (!input) return false;
      if (
        expectSessionId !== undefined &&
        input.sessionId !== undefined &&
        input.sessionId !== expectSessionId
      )
        return false;
      pendingInputs.delete(requestId);
      input.resolve(response);
      return true;
    },
    resolve(toolUseId, decision, expectSessionId) {
      sweep();
      const approval = pending.get(toolUseId);
      if (approval === undefined) return false;
      if (
        expectSessionId !== undefined &&
        approval.sessionId !== undefined &&
        approval.sessionId !== expectSessionId
      ) {
        return false;
      }
      // Deleted here as well as on `tool.confirm_resolved`: the resolver emits
      // that event synchronously, but a second HQ command racing this one must
      // not find the entry either way.
      pending.delete(toolUseId);
      approval.resolve(decision);
      return true;
    },
    register(approval) {
      pending.set(approval.toolUseId, approval);
      notify({ kind: 'requested', approval });
      return (decision = 'no') => {
        // Only announce if this entry is still ours. An HQ answer deletes it
        // and emits its own resolved change; announcing again here would tell
        // the dashboard the prompt was refused right after it was allowed.
        if (!pending.has(approval.toolUseId)) return;
        pending.delete(approval.toolUseId);
        notify({
          kind: 'resolved',
          toolUseId: approval.toolUseId,
          toolName: approval.toolName,
          sessionId: approval.sessionId,
          decision,
          source: 'user',
        });
      };
    },
    renew(toolUseId, deadlineAt) {
      const approval = pending.get(toolUseId);
      if (approval === undefined) return false;
      approval.deadlineAt = deadlineAt;
      // Re-announced, not silently updated: the dashboard derives the card
      // (and its countdown) from the published envelope, so a deadline it
      // never hears about is a deadline that does not exist.
      notify({ kind: 'requested', approval });
      return true;
    },
    dispose() {
      // Tolerant of a host EventBus whose `on()` returns nothing. This runs
      // inside a teardown sequence that also deregisters the mailbox and stops
      // the HQ socket, and a throw here would abandon the rest of it — losing
      // far more than an unsubscribed listener.
      for (const off of [
        offNeeded,
        offResolved,
        offInputRequested,
        offInputResolved,
        releaseObserver,
        releaseUserInputObserver,
      ]) {
        try {
          off?.();
        } catch {
          /* best-effort */
        }
      }
      listeners.clear();
      pending.clear();
      pendingInputs.clear();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface ApprovalTelemetryBridgeOptions extends BridgeContextOptions {
  /** The process-wide registry holding live prompts. */
  registry: ApprovalRegistry;
  /** Project root for path redaction in the argument summary. */
  projectRoot?: string | undefined;
}

/**
 * Start publishing approval activity to HQ. Returns a disposer.
 *
 * Every outstanding prompt is republished immediately, so the operator's view
 * is correct on a reconnect rather than only from the next prompt onward.
 */
export function startApprovalTelemetryBridge(opts: ApprovalTelemetryBridgeOptions): () => void {
  const { registry, publisher } = opts;
  const ctx = createBridgeContext(opts);

  const requestedPayload = (approval: PendingApproval): HqApprovalRequestedPayload => ({
    toolUseId: approval.toolUseId,
    toolName: approval.toolName,
    // Same redaction as `tool.started.inputSummary`. An approval payload
    // carries exactly the arguments an operator is being asked to bless, so
    // it is the LAST event that should bypass the redaction plane.
    inputSummary: summarizeHqToolArgs(approval.input, {
      policy: publisher.redactionPolicy,
      ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
    }),
    suggestedPattern: approval.suggestedPattern,
    ...(approval.riskTier !== undefined ? { riskTier: approval.riskTier } : {}),
    ...(approval.decisionSource !== undefined ? { decisionSource: approval.decisionSource } : {}),
    ...(approval.boundaryReason !== undefined ? { boundaryReason: approval.boundaryReason } : {}),
    ...(approval.writeTargets !== undefined && approval.writeTargets.length > 0
      ? { writeTargets: approval.writeTargets }
      : {}),
    deadlineAt: approval.deadlineAt,
    destructive: approval.destructive,
  });

  const publishRequested = (approval: PendingApproval): void => {
    ctx.safePublish({
      type: 'approval.requested',
      payload: requestedPayload(approval),
      ...ctx.sessionIdTag(approval.sessionId),
      timestamp: ctx.now(),
    });
  };

  // Replay first, so a dashboard that connects mid-prompt is not blind until
  // the next one.
  for (const approval of registry.list()) publishRequested(approval);
  const publishInputRequested = (input: PendingHqUserInput): void => {
    ctx.safePublish({
      type: 'user_input.requested',
      payload: { request: input.request },
      ...ctx.sessionIdTag(input.sessionId),
      timestamp: ctx.now(),
    });
  };
  for (const input of registry.listUserInputs?.() ?? []) publishInputRequested(input);

  const off = registry.onChange((change) => {
    if (change.kind === 'requested') {
      publishRequested(change.approval);
      return;
    }
    if (change.kind === 'input_requested') {
      publishInputRequested(change.input);
      return;
    }
    if (change.kind === 'input_resolved') {
      ctx.safePublish({
        type: 'user_input.resolved',
        payload: { requestId: change.requestId, response: change.response, source: change.source },
        ...ctx.sessionIdTag(change.sessionId),
        timestamp: ctx.now(),
      });
      return;
    }
    const payload: HqApprovalResolvedPayload = {
      toolUseId: change.toolUseId,
      toolName: change.toolName,
      decision: change.decision,
      source: change.source,
      ...(change.rationale !== undefined ? { rationale: change.rationale } : {}),
    };
    ctx.safePublish({
      type: 'approval.resolved',
      payload,
      ...ctx.sessionIdTag(change.sessionId),
      timestamp: ctx.now(),
    });
  });

  ctx.track(off);
  return () => ctx.dispose();
}
