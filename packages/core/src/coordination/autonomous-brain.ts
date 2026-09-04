/**
 * AutonomousBrain — LLM-backed decision-making engine for self-directing agents.
 *
 * Replaces the human-escalation model of `Brain` with a fully autonomous
 * decision engine. The Brain receives structured decision requests, evaluates
 * them against the KnowledgeGraph state, and produces decisions — without
 * ever prompting a human.
 *
 * ## Decision categories
 *
 * The Brain handles four categories of decisions:
 *
 * 1. **Spawn decisions** — Should we spawn a subagent? Which role? With what budget?
 * 2. **Approval decisions** — Should this proposed change be approved?
 * 3. **Priority decisions** — Which goal should be worked on next?
 * 4. **Escalation decisions** — Should this task be retried, delegated, or marked failed?
 *
 * ## Risk tiers
 *
 * Every decision has an associated risk tier that gates what the Brain can do:
 *
 * | Tier    | Example                          | Brain can decide alone? | Requires consensus? |
 * |---------|----------------------------------|-------------------------|----------------------|
 * | `low`   | Lint fix, comment cleanup        | ✅                      | No                   |
 * | `medium`| Refactor, new test               | ✅                      | No                   |
 * | `high`  | Change public API, deps update    | ✅                      | Yes (fast-track)     |
 * | `critical`| Delete major module, schema   | Escalate to consensus   | Yes (full vote)      |
 *
 * ## Integration with KnowledgeGraph
 *
 * The Brain READS from the graph (facts, goals, changes, decisions) and WRITES
 * its own decisions back as DecisionNodes. This creates an auditable decision
 * trail: every spawn, approval, and prioritization can be traced back to a
 * Brain decision with its rationale.
 *
 * ## Self-improvement
 *
 * The Brain tracks decision outcomes. If a spawn decision leads to a failed
 * subagent 3x in a row, the Brain learns to avoid that role/budget combination.
 * Decision history is stored as DecisionNodes in the graph.
 *
 * @module autonomous-brain
 */
import { randomUUID } from 'node:crypto';
import type {
  BrainArbiter,
  BrainDecision,
  BrainDecisionOption,
  BrainDecisionRequest,
  BrainDecisionSource,
  BrainRisk,
} from './brain.js';
import type { FleetBus } from './fleet-bus.js';
import type {
  ChangeNode,
  DecisionNode,
  FactNode,
  GoalNode,
  KnowledgeGraph,
} from './knowledge-graph.js';

export type { BrainRisk };

// ── Extended decision request types ─────────────────────────────────────

export type AutonomousDecisionType =
  | 'spawn'
  | 'approve_change'
  | 'reject_change'
  | 'prioritize_goals'
  | 'escalate_task'
  | 'rollback_change'
  | 'retry_task'
  | 'merge_results'
  | 'decompose_goal'
  | 'assign_task';

export interface AutonomousDecisionRequest {
  id: string;
  source: BrainDecisionSource;
  decisionType: AutonomousDecisionType;
  question: string;
  context: {
    /** Relevant facts from the knowledge graph */
    facts?: FactNode[];
    /** Goals relevant to this decision */
    goals?: GoalNode[];
    /** Change being reviewed (for approval decisions) */
    change?: ChangeNode;
    /** Current fleet status */
    fleetStatus?: {
      running: number;
      idle: number;
      total: number;
      costSoFar: number;
    };
    /** Task that triggered this decision */
    taskDescription?: string;
    /** Error that triggered escalation, if any */
    error?: string;
    /** Number of times this task has been attempted */
    attempts?: number;
  };
  options: BrainDecisionOption[];
  risk: BrainRisk;
  /** Whether this decision requires consensus */
  requiresConsensus: boolean;
}

export interface SpawnDecision {
  role: string;
  budget: {
    timeoutMs?: number;
    maxIterations?: number;
    maxToolCalls?: number;
    maxCostUsd?: number;
  };
  rationale: string;
}

export interface ApprovalDecision {
  approved: boolean;
  rationale: string;
  waivers?: string[];
  conditions?: string[]; // e.g. "must add tests for auth/session.ts"
}

export interface PrioritizationDecision {
  orderedGoals: string[]; // goal ids in priority order
  rationale: string;
}

export interface EscalationDecision {
  action: 'retry' | 'delegate' | 'mark_failed' | 'ask_for_help';
  rationale: string;
  budgetAdjustment?: {
    increaseFactor?: number;
    newTimeoutMs?: number;
    addModel?: string;
  };
}

// ── AutonomousBrain implementation ────────────────────────────────────────

export interface AutonomousBrainOptions {
  /** The LLM provider for making decisions */
  llmProvider: LLMProvider;
  graph: KnowledgeGraph;
  fleet?: FleetBus | undefined;
  /** Maximum retries before a task is marked failed. Default: 3. */
  maxRetries?: number | undefined;
  /** Risk threshold above which consensus is required. Default: 'high'. */
  consensusRiskThreshold?: BrainRisk | undefined;
  /**
   * Resolves a decision that `requiresConsensus` — typically a
   * `ConsensusProtocol` vote. Resolve `true` to approve the chosen option,
   * `false` to reject it.
   *
   * When absent, a consensus-required decision ESCALATES (`ask_human`)
   * instead of being returned as an executable answer: nothing in the
   * process is able to approve it, and the escalation tier is exactly the
   * layer built to settle that (a human interactively, the terminal policy
   * when headless).
   */
  consensus?:
    | ((input: {
        request: AutonomousDecisionRequest;
        optionId: string;
        rationale: string;
      }) => Promise<boolean>)
    | undefined;
  /** Self-improve: track decision history for learning. Default: true. */
  selfImprove?: boolean | undefined;
}

export interface LLMProvider {
  /**
   * Generate a decision. Receives the full context as a structured prompt.
   * Returns the chosen option id and rationale.
   */
  decide(prompt: DecisionPrompt): Promise<{ optionId: string; rationale: string }>;
}

export interface DecisionPrompt {
  decisionType: AutonomousDecisionType;
  question: string;
  context: string; // serialized relevant graph state
  options: BrainDecisionOption[];
  risk: BrainRisk;
  decisionHistory: DecisionNode[];
  /** Hints derived from self-improvement data */
  selfImproveHints?: string[];
}

export class AutonomousBrain implements BrainArbiter {
  private readonly graph: KnowledgeGraph;
  // Fleet bus for emitting decisions — null-safe, no-op if not provided
  private readonly fleetBus?: FleetBus | undefined;
  private readonly llmProvider: LLMProvider;
  private readonly maxRetries: number;
  private readonly consensusRiskThreshold: BrainRisk;
  private readonly consensus: AutonomousBrainOptions['consensus'];
  private readonly selfImprove: boolean;

  /** Tracks failure patterns for self-improvement. */
  private failurePatterns = new Map<string, { failures: number; lastFailure: string }>();

  private readonly RISK_ORDER: BrainRisk[] = ['low', 'medium', 'high', 'critical'];

  // ── Fleet bus integration ─────────────────────────────────────────────

  private _emit(type: string, payload: Record<string, unknown>): void {
    if (!this.fleetBus) return;
    this.fleetBus.emit({ subagentId: 'brain', ts: Date.now(), type, payload });
  }

  constructor(opts: AutonomousBrainOptions) {
    this.graph = opts.graph;
    this.fleetBus = opts.fleet ?? undefined;
    this.llmProvider = opts.llmProvider;
    this.maxRetries = opts.maxRetries ?? 3;
    this.consensusRiskThreshold = opts.consensusRiskThreshold ?? 'high';
    this.consensus = opts.consensus;
    this.selfImprove = opts.selfImprove ?? true;
  }

  // ── BrainArbiter interface ────────────────────────────────────────────

  /** Implements BrainArbiter — bridges standard brain.ts interface to autonomous engine. */
  async decide(request: BrainDecisionRequest): Promise<BrainDecision> {
    return this.decideAuto(this._toAutonomous(request));
  }

  // ── Main entry point ──────────────────────────────────────────────────

  /**
   * Primary autonomous decision engine — receives AutonomousDecisionRequest,
   * queries the LLM, records the decision, and returns a BrainDecision.
   *
   * Specialized methods (decideSpawn, decideApproval, etc.) should call this
   * directly with a pre-built AutonomousDecisionRequest.
   */
  async decideAuto(request: AutonomousDecisionRequest): Promise<BrainDecision> {
    const { id, decisionType, question, context, options, risk, requiresConsensus } = request;

    // Load decision history for context
    const history = this.selfImprove ? this._loadHistory(decisionType, risk) : [];
    const hints = this.selfImprove ? this._getSelfImproveHints(decisionType) : [];

    // Build the LLM prompt
    const prompt: DecisionPrompt = {
      decisionType,
      question,
      context: this._serializeContext(context),
      options,
      risk,
      decisionHistory: history,
      selfImproveHints: hints,
    };

    let result: { optionId: string; rationale: string };

    try {
      result = await this.llmProvider.decide(prompt);
    } catch (err) {
      // Fallback: pick the recommended option or deny
      const recommended = options.find((o) => o.recommended);
      if (recommended && risk === 'low') {
        return { type: 'answer', optionId: recommended.id, text: recommended.label };
      }
      return { type: 'deny', reason: `Brain LLM failed: ${String(err)}` };
    }

    // Record the decision in the knowledge graph (fire-and-forget for perf).
    // Use .catch(() => {}) rather than void — void discards the return value
    // but does NOT swallow promise rejections, so errors would become unhandled
    // promise rejections that crash the process.
    this._recordDecision({
      id,
      decisionType,
      question,
      options,
      chosen: result.optionId,
      rationale: result.rationale,
      madeBy: 'autonomous-brain',
      context: JSON.stringify(context),
    }).catch(() => {});

    // Handle consensus requirement.
    //
    // This used to return a normal `answer` with a warning appended to the
    // PROSE rationale, plus a fleet event nobody consumed. Brain decisions
    // are control-plane input — consumers act on the exact `optionId` and
    // never read prose — so a decision declared to need approval was
    // indistinguishable from an approved one and executed unapproved.
    // `consensusRiskThreshold` was therefore entirely inert.
    if (requiresConsensus) {
      this._emit('brain.decision', {
        id,
        decisionType,
        optionId: result.optionId,
        rationale: result.rationale,
        consensusRequired: true,
      });
      const label = options.find((o) => o.id === result.optionId)?.label ?? result.optionId;
      if (this.consensus) {
        const approved = await this.consensus({
          request,
          optionId: result.optionId,
          rationale: result.rationale,
        }).catch(() => false);
        if (!approved) {
          return {
            type: 'deny',
            reason: `Consensus rejected "${label}" for: ${question}`,
          };
        }
        return {
          type: 'answer',
          optionId: result.optionId,
          text: label,
          rationale: `${result.rationale} (approved by consensus)`,
        };
      }
      // Nothing wired can approve it — hand it to the escalation tier rather
      // than executing it. The chosen option travels in the prompt so a human
      // (or the headless terminal policy) decides on the real proposal.
      return {
        type: 'ask_human',
        prompt:
          `Consensus required (${risk} risk) before executing "${label}".\n\n` +
          `Question: ${question}\nProposed: ${label}\nRationale: ${result.rationale}`,
        options,
        rationale: 'Decision requires consensus approval and no consensus resolver is wired.',
      };
    }

    this._emit('brain.decision', {
      id,
      decisionType,
      optionId: result.optionId,
      rationale: result.rationale,
      consensusRequired: false,
    });

    return {
      type: 'answer',
      optionId: result.optionId,
      text: options.find((o) => o.id === result.optionId)?.label ?? result.optionId,
      rationale: result.rationale,
    };
  }

  // ── Specialized decision methods ────────────────────────────────────

  /**
   * Decide whether to spawn a subagent, which role to use, and what budget.
   */
  async decideSpawn(
    source: BrainDecisionSource,
    taskDescription: string,
    availableFacts: FactNode[],
    fleetStatus: { running: number; idle: number; total: number; costSoFar: number },
  ): Promise<BrainDecision> {
    // Pick the best role based on task description
    const roleHints = this._inferRoles(taskDescription);
    const risk = roleHints.length > 1 ? 'medium' : 'low';

    const options: BrainDecisionOption[] = roleHints.map((role, i) => ({
      id: `spawn:${role}`,
      label: `Spawn ${role} agent`,
      risk: i === 0 ? 'low' : 'medium',
      recommended: i === 0,
      consequence:
        i === 0
          ? `Spawn the most appropriate agent for: ${taskDescription.slice(0, 80)}`
          : `Spawn an alternative agent for the same task`,
    }));

    return this.decideAuto({
      id: randomUUID(),
      source,
      decisionType: 'spawn',
      question: `Should we spawn a subagent for this task?`,
      context: {
        facts: availableFacts,
        fleetStatus,
        taskDescription,
      },
      options,
      risk,
      requiresConsensus: false,
    });
  }

  /**
   * Decide whether to approve a proposed change.
   */
  async decideApproval(
    source: BrainDecisionSource,
    change: ChangeNode,
    relevantFacts: FactNode[],
  ): Promise<BrainDecision> {
    const risk = this._changeRisk(change);

    const options: BrainDecisionOption[] = [
      {
        id: 'approve',
        label: 'Approve change',
        recommended:
          change.qualityGate.passed &&
          relevantFacts.filter((f) => f.severity === 'critical').length === 0,
        risk,
        consequence: `Apply changes to: ${change.files.map((f) => f.path).join(', ')}`,
      },
      {
        id: 'reject',
        label: 'Reject change',
        recommended: false,
        risk: 'medium',
        consequence: 'Return change to proposer with feedback',
      },
      {
        id: 'request_changes',
        label: 'Request specific changes',
        recommended: false,
        risk: 'low',
        consequence: 'Send back for revision with conditions',
      },
    ];

    return this.decideAuto({
      id: randomUUID(),
      source,
      decisionType: 'approve_change',
      question: `Should we approve the change "${change.title}"?`,
      context: {
        facts: relevantFacts,
        change,
      },
      options,
      risk,
      requiresConsensus: risk === 'critical' || risk === 'high',
    });
  }

  /**
   * Decide how to handle a failed task.
   */
  async decideEscalation(
    source: BrainDecisionSource,
    taskId: string,
    error: string,
    attempts: number,
  ): Promise<BrainDecision> {
    const retryCount = this.failurePatterns.get(taskId)?.failures ?? attempts;

    const options: BrainDecisionOption[] = [];

    if (retryCount < this.maxRetries) {
      options.push({
        id: 'retry',
        label: `Retry task (attempt ${retryCount + 1}/${this.maxRetries})`,
        recommended: retryCount < 2,
        risk: 'medium',
        consequence: `Restart the task with same or adjusted budget`,
      });
      options.push({
        id: 'retry_with_adjustment',
        label: `Retry with more budget`,
        recommended: retryCount >= 1,
        risk: 'medium',
        consequence: `Increase timeout or iterations before retrying`,
      });
    }

    options.push({
      id: 'delegate',
      label: 'Delegate to different role',
      recommended: retryCount >= 1,
      risk: 'medium',
      consequence: 'Try a different agent role for the same task',
    });

    if (retryCount >= this.maxRetries) {
      options.push({
        id: 'mark_failed',
        label: 'Mark task as failed',
        recommended: true,
        risk: 'high',
        consequence: 'Stop retrying, propagate failure upward',
      });
    }

    options.push({
      id: 'decompose',
      label: 'Decompose and retry in parts',
      recommended: false,
      risk: 'low',
      consequence: 'Break the task into smaller sub-tasks',
    });

    return this.decideAuto({
      id: randomUUID(),
      source,
      decisionType: 'escalate_task',
      question: `Task failed: ${error.slice(0, 100)}. How should we proceed?`,
      context: { error, attempts: retryCount },
      options,
      risk: retryCount >= this.maxRetries ? 'critical' : 'medium',
      requiresConsensus: false,
    });
  }

  // ── Self-improvement ─────────────────────────────────────────────────

  /**
   * Record the outcome of a decision for self-improvement.
   * Call this after a spawned agent completes or a change is applied.
   */
  recordOutcome(decisionId: string, outcome: 'success' | 'failure', _detail?: string): void {
    const node = this.graph.get(decisionId) as DecisionNode | undefined;
    if (!node) return;

    const key = `decision:${node.decisionType}`;
    if (outcome === 'failure') {
      const existing = this.failurePatterns.get(key) ?? { failures: 0, lastFailure: '' };
      existing.failures += 1;
      existing.lastFailure = new Date().toISOString();
      this.failurePatterns.set(key, existing);
    } else {
      this.failurePatterns.delete(key);
    }

    void this.graph.update(decisionId, {
      decisionType: node.decisionType,
    } as Partial<DecisionNode>);
  }

  private _getSelfImproveHints(decisionType: AutonomousDecisionType): string[] {
    const pattern = this.failurePatterns.get(`decision:${decisionType}`);
    if (!pattern || pattern.failures < 2) return [];
    return [
      `⚠️ ${decisionType} decisions have failed ${pattern.failures} times recently.`,
      'Consider alternative approaches before defaulting to this pattern.',
    ];
  }

  // ── Private ───────────────────────────────────────────────────────────

  private _toAutonomous(req: BrainDecisionRequest): AutonomousDecisionRequest {
    const decisionType = this._inferDecisionType(req);
    return {
      id: req.id,
      source: req.source,
      decisionType,
      question: req.question,
      context: {
        taskDescription: req.context ?? '',
      },
      options: req.options ?? [],
      risk: req.risk,
      requiresConsensus:
        this.RISK_ORDER.indexOf(req.risk) >= this.RISK_ORDER.indexOf(this.consensusRiskThreshold),
    };
  }

  private _inferDecisionType(req: BrainDecisionRequest): AutonomousDecisionType {
    // Lowercase once instead of up to 5× per call.
    const q = req.question.toLowerCase();
    if (q.includes('spawn')) return 'spawn';
    if (q.includes('approve') || q.includes('change')) return 'approve_change';
    if (q.includes('retry') || q.includes('fail')) return 'retry_task';
    if (q.includes('priorit')) return 'prioritize_goals';
    if (q.includes('decompos')) return 'decompose_goal';
    return 'assign_task';
  }

  private _serializeContext(ctx: AutonomousDecisionRequest['context']): string {
    const parts: string[] = [];
    if (ctx.facts?.length) {
      parts.push(
        `## Relevant Facts\n${ctx.facts.map((f) => `- [${f.severity ?? 'info'}] ${f.subject}: ${f.detail}`).join('\n')}`,
      );
    }
    if (ctx.goals?.length) {
      parts.push(
        `## Active Goals\n${ctx.goals.map((g) => `- [${g.status}] ${g.priority}: ${g.title}`).join('\n')}`,
      );
    }
    if (ctx.change) {
      const c = ctx.change;
      parts.push(
        `## Change Under Review\n- Title: ${c.title}\n- Status: ${c.status}\n- Files: ${c.files.map((f) => `${f.action} ${f.path}`).join(', ')}\n- Quality gate: ${c.qualityGate.passed ? 'PASSED' : 'FAILED'}\n  Checks: ${c.qualityGate.checks.map((ch) => `${ch.name}:${ch.passed ? '✅' : '❌'}`).join(', ')}`,
      );
    }
    if (ctx.fleetStatus) {
      parts.push(
        `## Fleet Status\n- Running: ${ctx.fleetStatus.running}, Idle: ${ctx.fleetStatus.idle}, Total: ${ctx.fleetStatus.total}\n- Cost so far: $${ctx.fleetStatus.costSoFar.toFixed(4)}`,
      );
    }
    if (ctx.taskDescription) {
      parts.push(`## Task\n${ctx.taskDescription}`);
    }
    if (ctx.error) {
      parts.push(`## Error\n${ctx.error}`);
    }
    return parts.join('\n\n');
  }

  private _loadHistory(type: AutonomousDecisionType, _risk: BrainRisk): DecisionNode[] {
    // Load last 10 decisions of same type from graph
    const all = this.graph.getDecisions().filter((d) => d.decisionType === type);
    return all.slice(-10) as DecisionNode[];
  }

  private async _recordDecision(input: {
    id: string;
    decisionType: string;
    question: string;
    options: BrainDecisionOption[];
    chosen: string;
    rationale: string;
    madeBy: string;
    context?: string;
  }): Promise<DecisionNode> {
    const node = (await this.graph.add({
      type: 'decision',
      decisionType: input.decisionType as DecisionNode['decisionType'],
      question: input.question,
      options: input.options,
      chosen: input.chosen,
      rationale: input.rationale,
      madeBy: input.madeBy,
      madeAt: new Date().toISOString(),
      context: input.context,
    } as Omit<DecisionNode, 'id'>)) as DecisionNode;
    return node;
  }

  private _inferRoles(task: string): string[] {
    const t = task.toLowerCase();
    if (t.includes('bug') || t.includes('error') || t.includes('crash'))
      return ['bug-hunter', 'fixer'];
    if (t.includes('security') || t.includes('secret') || t.includes('injection'))
      return ['security-scanner'];
    if (t.includes('refactor') || t.includes('architecture') || t.includes('debt'))
      return ['refactor-planner', 'critic'];
    if (t.includes('audit') || t.includes('log') || t.includes('analyze')) return ['audit-log'];
    if (t.includes('test') || t.includes('coverage')) return ['tester', 'bug-hunter'];
    return ['bug-hunter', 'refactor-planner'];
  }

  private _changeRisk(change: ChangeNode): BrainRisk {
    const criticalFiles = change.files.filter(
      (f) => f.path.includes('auth') || f.path.includes('config') || f.path.includes('schema'),
    );
    if (criticalFiles.length > 0) return 'high';
    if (change.files.length > 10) return 'medium';
    return 'low';
  }
}
