/**
 * BrainMonitor — the Brain's SELF-ACTIVATION layer.
 *
 * The BrainArbiter alone is reactive: subsystems (director, autophase,
 * eternal engine) ask it questions. The monitor closes the loop the other
 * way — it WATCHES the live EventBus for distress signals, consults the
 * Brain proactively, and when the decision calls for it, INTERVENES in the
 * running work by delivering a corrective steer to the working agent
 * (steers are folded into the agent's conversation before its next step
 * via the mailbox loop, so no new plumbing is needed).
 *
 * Watched signals:
 *   - tool-failure streak — the same tool failing N times consecutively
 *     (default 3). Classic stuck-loop: the agent keeps retrying an
 *     approach that does not work.
 *   - error storm — N `error` events within a sliding window (default
 *     4 in 60s). Something is systematically wrong.
 *   - agent stall — a run is active (`agent.run.started` without its
 *     matching completion) but no tool call or iteration progress has been
 *     observed for `stallMs` (default 5 min). A wedged provider call or a
 *     dead-loop that produces no work.
 *   - file churn — the same file edited ≥ N times (default 5) within a
 *     sliding window (default 10 min). Classic edit/revert oscillation:
 *     the agent keeps rewriting the same file without converging.
 *
 * Decision contract: every consultation offers [steer | continue] with
 * fallback `continue`, at `medium` risk. Degradation is safe by design:
 *   - tiered brain with an LLM layer → a real judgement call, with the
 *     LLM's rationale becoming the steer text;
 *   - policy-only brain → fallback `continue` → observe, never interfere.
 *
 * Every engagement (whether or not it intervened) emits
 * `brain.intervention` for the TUI/WebUI surfaces, and is rate-limited by
 * a per-signal cooldown so the Brain never spams the agent.
 *
 * @module brain-monitor
 */

import { randomUUID } from 'node:crypto';
import type { BrainInterventionKind, EventBus } from '../kernel/events.js';
import type { BrainArbiter, BrainDecision, BrainDecisionRequest } from './brain.js';

export type { BrainInterventionKind };

export interface BrainInterventionInput {
  subject: string;
  body: string;
}

export interface BrainMonitorOptions {
  events: EventBus;
  brain: BrainArbiter;
  /** Active host session id, read lazily so resume/new-session switches are reflected. */
  sessionId?: (() => string | undefined) | undefined;
  /**
   * Leader session id used to filter out subagent events. The BrainMonitor
   * subscribes to global events (tool.executed, agent.run.*, error, etc.)
   * which fire for BOTH the leader agent and subagents. Without this filter,
   * a subagent's tool failures or stalls incorrectly trigger a steer to the
   * leader — disrupting the leader's work for problems it didn't cause.
   *
   * When set, any event whose `sessionId` differs from this value is skipped.
   * Events without a `sessionId` field are always passed through (backward
   * compatibility). Pass a **lazy getter** when the session id may change
   * at runtime (session resume), or a string for static sessions.
   */
  leaderSessionId?: string | (() => string | undefined) | undefined;
  /**
   * Deliver a corrective steer to the working agent(s). Hosts typically
   * send a `steer` mail to this session's leader via the project
   * GlobalMailbox — the agent loop injects it before the next LLM call.
   */
  intervene: (input: BrainInterventionInput) => Promise<void>;
  /** Consecutive failures of the SAME tool before engaging. Default 3. */
  toolFailureStreak?: number | undefined;
  /** Number of `error` events within the window before engaging. Default 4. */
  errorStormCount?: number | undefined;
  /** Sliding window for the error storm signal (ms). Default 60_000. */
  errorStormWindowMs?: number | undefined;
  /**
   * Active run with no observable progress (tool call / iteration) for this
   * long → agent-stall signal. Default 300_000 (5 min). 0 disables.
   */
  stallMs?: number | undefined;
  /** How often the stall watchdog checks (ms). Default 30_000. */
  stallCheckIntervalMs?: number | undefined;
  /** Edits to the SAME file within the churn window before engaging. Default 5. */
  fileChurnThreshold?: number | undefined;
  /** Sliding window for the file-churn signal (ms). Default 600_000 (10 min). */
  fileChurnWindowMs?: number | undefined;
  /** Minimum gap between engagements of the same signal kind (ms). Default 120_000. */
  cooldownMs?: number | undefined;
}

/** Tools whose successful execution mutates a file we can churn-track. */
const FILE_EDIT_TOOLS = new Set(['edit', 'write', 'patch', 'multi_edit', 'multiedit', 'str_replace']);

/** Best-effort path extraction from a file-editing tool's input. */
function editedPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const r = input as Record<string, unknown>;
  const candidate = r['file_path'] ?? r['path'] ?? r['filePath'] ?? r['file'];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

export class BrainMonitor {
  private readonly failStreaks = new Map<string, number>();
  private errorTimestamps: number[] = [];
  private readonly editTimestamps = new Map<string, number[]>();
  private readonly lastEngagedAt = new Map<string, number>();
  private readonly unsubscribers: Array<() => void> = [];
  private engaging = false;
  private activeRuns = 0;
  private lastProgressAt = 0;
  private stallTimer: ReturnType<typeof setInterval> | undefined;

  private readonly toolFailureStreak: number;
  private readonly errorStormCount: number;
  private readonly errorStormWindowMs: number;
  private readonly stallMs: number;
  private readonly stallCheckIntervalMs: number;
  private readonly fileChurnThreshold: number;
  private readonly fileChurnWindowMs: number;
  private readonly cooldownMs: number;

  /** Resolve the leader's own session id for event filtering. */
  private resolveLeaderSessionId(): string | undefined {
    const id = this.opts.leaderSessionId;
    return typeof id === 'function' ? id() : id;
  }

  constructor(private readonly opts: BrainMonitorOptions) {
    this.toolFailureStreak = opts.toolFailureStreak ?? 3;
    this.errorStormCount = opts.errorStormCount ?? 4;
    this.errorStormWindowMs = opts.errorStormWindowMs ?? 60_000;
    this.stallMs = opts.stallMs ?? 300_000;
    this.stallCheckIntervalMs = opts.stallCheckIntervalMs ?? 30_000;
    this.fileChurnThreshold = opts.fileChurnThreshold ?? 5;
    this.fileChurnWindowMs = opts.fileChurnWindowMs ?? 600_000;
    this.cooldownMs = opts.cooldownMs ?? 120_000;
  }

  start(): void {
    this.unsubscribers.push(
      this.opts.events.on('tool.executed', (e) => {
        // Ignore subagent tool events — only respond to the leader's own tool activity
        const leaderSid = this.resolveLeaderSessionId();
        if (leaderSid && e.sessionId && e.sessionId !== leaderSid) return;

        this.lastProgressAt = Date.now();
        this.trackFileChurn(e.name, e.ok, e.input);
        if (e.ok) {
          this.failStreaks.delete(e.name);
          return;
        }
        const streak = (this.failStreaks.get(e.name) ?? 0) + 1;
        this.failStreaks.set(e.name, streak);
        if (streak >= this.toolFailureStreak) {
          this.failStreaks.delete(e.name);
          void this.engage('tool_failure_streak', {
            question: `The tool "${e.name}" has failed ${streak} times in a row. Should the agent be steered to a different approach?`,
            context: [
              `Tool: ${e.name}`,
              `Consecutive failures: ${streak}`,
              e.output ? `Last output (truncated): ${String(e.output).slice(0, 400)}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          });
        }
      }),
    );

    // ── Agent-stall watchdog ─────────────────────────────────────────────
    if (this.stallMs > 0) {
      this.unsubscribers.push(
        this.opts.events.on('agent.run.started', (e) => {
          // Ignore subagent run events — only track the leader's runs
          const lsid = this.resolveLeaderSessionId();
          if (lsid && e.sessionId && e.sessionId !== lsid) return;
          this.activeRuns += 1;
          this.lastProgressAt = Date.now();
        }),
        this.opts.events.on('agent.run.completed', (e) => {
          const lsid = this.resolveLeaderSessionId();
          if (lsid && e.sessionId && e.sessionId !== lsid) return;
          this.activeRuns = Math.max(0, this.activeRuns - 1);
        }),
        this.opts.events.on('agent.run.error', (e) => {
          const lsid = this.resolveLeaderSessionId();
          if (lsid && e.sessionId && e.sessionId !== lsid) return;
          this.activeRuns = Math.max(0, this.activeRuns - 1);
        }),
        this.opts.events.on('iteration.started', (e) => {
          const lsid = this.resolveLeaderSessionId();
          if (lsid && e.sessionId && e.sessionId !== lsid) return;
          this.lastProgressAt = Date.now();
        }),
      );
      this.stallTimer = setInterval(() => {
        if (this.activeRuns === 0 || this.lastProgressAt === 0) return;
        const idleMs = Date.now() - this.lastProgressAt;
        if (idleMs < this.stallMs) return;
        // Re-arm from now so a declined steer doesn't re-fire every tick
        // (the per-kind cooldown also applies).
        this.lastProgressAt = Date.now();
        void this.engage('agent_stall', {
          question: `An active run has made no observable progress (no tool call or iteration) for ${Math.round(idleMs / 60_000)} minute(s). Should the agent be steered before more time is wasted?`,
          context: [
            `Active runs: ${this.activeRuns}`,
            `Idle for: ${Math.round(idleMs / 1000)}s`,
            `Stall threshold: ${Math.round(this.stallMs / 1000)}s`,
          ].join('\n'),
        });
      }, this.stallCheckIntervalMs);
      this.stallTimer.unref?.();
    }

    this.unsubscribers.push(
      this.opts.events.on('error', (e) => {
        // Ignore subagent errors — only respond to the leader's own errors
        const lsid = this.resolveLeaderSessionId();
        if (lsid && e.sessionId && e.sessionId !== lsid) return;

        const now = Date.now();
        this.errorTimestamps.push(now);
        this.errorTimestamps = this.errorTimestamps.filter(
          (t) => now - t <= this.errorStormWindowMs,
        );
        if (this.errorTimestamps.length >= this.errorStormCount) {
          const count = this.errorTimestamps.length;
          this.errorTimestamps = [];
          const message = e.err instanceof Error ? e.err.message : String(e.err);
          void this.engage('error_storm', {
            question: `${count} errors occurred within ${Math.round(this.errorStormWindowMs / 1000)}s (phase: ${e.phase}). Should the agent be steered before more work is wasted?`,
            context: `Latest error: ${message.slice(0, 400)}`,
          });
        }
      }),
    );
  }

  stop(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.failStreaks.clear();
    this.errorTimestamps = [];
    this.editTimestamps.clear();
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = undefined;
    }
    this.activeRuns = 0;
    this.lastProgressAt = 0;
  }

  /** Sliding-window count of successful edits per file → churn signal. */
  private trackFileChurn(toolName: string, ok: boolean, input: unknown): void {
    if (!ok || !FILE_EDIT_TOOLS.has(toolName.toLowerCase())) return;
    const path = editedPath(input);
    if (!path) return;
    const now = Date.now();
    const stamps = (this.editTimestamps.get(path) ?? []).filter(
      (t) => now - t <= this.fileChurnWindowMs,
    );
    stamps.push(now);
    if (stamps.length >= this.fileChurnThreshold) {
      this.editTimestamps.delete(path);
      void this.engage('file_churn', {
        question: `The file "${path}" has been edited ${stamps.length} times within ${Math.round(this.fileChurnWindowMs / 60_000)} minutes — the agent may be oscillating (edit/revert loop) instead of converging. Should it be steered?`,
        context: [
          `File: ${path}`,
          `Edits in window: ${stamps.length}`,
          `Window: ${Math.round(this.fileChurnWindowMs / 1000)}s`,
        ].join('\n'),
      });
      return;
    }
    this.editTimestamps.set(path, stamps);
  }

  private async engage(
    kind: BrainInterventionKind,
    input: { question: string; context: string },
  ): Promise<void> {
    // Rate limits: per-kind cooldown + never more than one engagement in
    // flight (an LLM-backed brain call can take seconds).
    const last = this.lastEngagedAt.get(kind) ?? 0;
    if (this.engaging || Date.now() - last < this.cooldownMs) return;
    this.engaging = true;
    this.lastEngagedAt.set(kind, Date.now());
    try {
      const request: BrainDecisionRequest = {
        id: `brainmon-${randomUUID()}`,
        sessionId: this.opts.sessionId?.(),
        source: 'system',
        question: input.question,
        context: input.context,
        options: [
          {
            id: 'steer',
            label: 'Steer the agent with corrective guidance',
            consequence: 'A steer message is injected before its next step.',
            risk: 'low',
            recommended: true,
          },
          {
            id: 'continue',
            label: 'Let the agent continue unaided',
            risk: 'low',
          },
        ],
        risk: 'medium',
        // 'ask_human' routes to the LLM-backed autonomous layer via
        // createTieredBrainArbiter before any human escalation.
        fallback: 'ask_human',
      };
      const decision = await this.opts.brain.decide(request);
      const intervened = await this.maybeIntervene(kind, request, decision);
      this.opts.events.emit('brain.intervention', {
        sessionId: request.sessionId,
        kind,
        request,
        decision,
        intervened,
        at: Date.now(),
      });
    } catch {
      // The monitor must never destabilize the host it protects.
    } finally {
      this.engaging = false;
    }
  }

  private async maybeIntervene(
    kind: string,
    request: BrainDecisionRequest,
    decision: BrainDecision,
  ): Promise<boolean> {
    if (decision.type !== 'answer') return false;
    // Intervene when the brain explicitly chose the steer option, or gave a
    // free-text answer that is not the bare continue fallback.
    const choseSteer = decision.optionId === 'steer';
    const freeTextGuidance =
      !decision.optionId &&
      !/^continue\b/i.test(decision.text.trim()) &&
      decision.text.trim().length > 0;
    if (!choseSteer && !freeTextGuidance) return false;
    const guidance = decision.rationale?.trim() || decision.text.trim();
    try {
      await this.opts.intervene({
        subject: `Brain intervention: ${kind.replace(/_/g, ' ')}`,
        body: [
          `The Brain engaged after detecting: ${request.question}`,
          '',
          `Guidance: ${guidance}`,
          '',
          'Adjust your approach accordingly — do not simply retry the same action.',
        ].join('\n'),
      });
      return true;
    } catch {
      return false;
    }
  }
}
