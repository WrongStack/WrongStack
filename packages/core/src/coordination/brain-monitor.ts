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
 * Watched signals (v1):
 *   - tool-failure streak — the same tool failing N times consecutively
 *     (default 3). Classic stuck-loop: the agent keeps retrying an
 *     approach that does not work.
 *   - error storm — N `error` events within a sliding window (default
 *     4 in 60s). Something is systematically wrong.
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
import type { EventBus } from '../kernel/events.js';
import type { BrainArbiter, BrainDecision, BrainDecisionRequest } from './brain.js';

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
  /** Minimum gap between engagements of the same signal kind (ms). Default 120_000. */
  cooldownMs?: number | undefined;
}

export class BrainMonitor {
  private readonly failStreaks = new Map<string, number>();
  private errorTimestamps: number[] = [];
  private readonly lastEngagedAt = new Map<string, number>();
  private readonly unsubscribers: Array<() => void> = [];
  private engaging = false;

  private readonly toolFailureStreak: number;
  private readonly errorStormCount: number;
  private readonly errorStormWindowMs: number;
  private readonly cooldownMs: number;

  constructor(private readonly opts: BrainMonitorOptions) {
    this.toolFailureStreak = opts.toolFailureStreak ?? 3;
    this.errorStormCount = opts.errorStormCount ?? 4;
    this.errorStormWindowMs = opts.errorStormWindowMs ?? 60_000;
    this.cooldownMs = opts.cooldownMs ?? 120_000;
  }

  start(): void {
    this.unsubscribers.push(
      this.opts.events.on('tool.executed', (e) => {
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

    this.unsubscribers.push(
      this.opts.events.on('error', (e) => {
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
  }

  private async engage(
    kind: 'tool_failure_streak' | 'error_storm',
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
