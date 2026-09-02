/**
 * TaskAuctioneer — project-wide autonomous task marketplace.
 *
 * Broadcasts available tasks to all agents across all sessions (CLI, TUI, WebUI, REPL).
 * Idle agents can browse, bid on, and claim tasks. Replaces manual leader-side
 * spawn+assign with an open market where agents self-select work.
 *
 * ## How it works
 *
 * 1. **Publish**: Any agent (or the Brain) publishes a task to the KnowledgeGraph
 *    as a GoalNode with status=pending. The Auctioneer broadcasts it via FleetBus
 *    and Mailbox (cross-session).
 *
 * 2. **Broadcast**: Every online agent receives the task. The FleetBus carries the
 *    task event in-process; the Mailbox carries it cross-session (same project,
 *    different terminal sessions).
 *
 * 3. **Bid**: Agents express interest by calling `bid(taskId, {capability, rationale})`.
 *    Multiple agents can bid on the same task.
 *
 * 4. **Claim**: The Auctioneer evaluates bids using the Dispatcher and awards the task
 *    to the best-fit agent. The winner is assigned the GoalNode and notified via
 *    mailbox.
 *
 * 5. **Work**: The claiming agent works autonomously, updating the GoalNode status
 *    as it progresses.
 *
 * 6. **Complete**: On finish, the agent publishes results and the Auctioneer marks
 *    the goal as done.
 *
 * ## Cross-session coordination
 *
 * - FleetBus: in-process events for agents in the same session
 * - Mailbox: cross-session broadcasts — agents in other terminal sessions see tasks too
 * - KnowledgeGraph: shared state for bidding and claiming across sessions
 *
 * ## Idle agent work-finding
 *
 * An idle agent (no current task) can call `findWork(agentId)` to get the best
 * available tasks for its capabilities, or subscribe to `task:available` events
 * via the FleetBus. This means a leader never has to manually assign work —
 * idle agents proactively find it.
 *
 * @module task-auctioneer
 */
import { randomUUID } from 'node:crypto';
import type { GoalNode, GoalStatus, GoalPriority } from './knowledge-graph.js';
import type { KnowledgeGraph } from './knowledge-graph.js';
import type { FleetBus } from './fleet-bus.js';
import type { Mailbox } from './mailbox-types.js';
import { dispatchAgent } from './dispatcher.js';

export type { GoalStatus, GoalPriority };

// ── Task bid ─────────────────────────────────────────────────────────────

export interface TaskBid {
  id: string;
  taskId: string;
  agentId: string;
  agentName: string;
  agentRole: string;
  /** Dispatcher score for this task */
  score: number;
  /** Why this agent is a good fit */
  rationale: string;
  submittedAt: string;
}

// ── Auctioneer options ───────────────────────────────────────────────────

export interface TaskAuctionOptions {
  graph: KnowledgeGraph;
  fleet?: FleetBus | undefined;
  mailbox?: Mailbox | undefined;
  selfAgentId?: string | undefined;
  /** How long a bid window stays open before auto-awarding. Default: 30s */
  bidWindowMs?: number | undefined;
  /** Maximum concurrent tasks per agent. Default: 3 */
  maxTasksPerAgent?: number | undefined;
  /** Minimum confidence threshold for dispatcher scoring. Default: 0.3 */
  minConfidence?: number | undefined;
  /**
   * Maximum times a task can be republished when no bids are received.
   * After this, the task is marked as 'failed' with reason 'no_bids'.
   * Default: 3.
   */
  maxBidRetries?: number | undefined;
}

// ── TaskAuctioneer ──────────────────────────────────────────────────────

/**
 * A goal that has reached `done` or `failed` is finished for good — the same
 * two states `KnowledgeGraph._isTerminal` treats as terminal when it prunes.
 * `KnowledgeGraph.update` merges patches without consulting the current state,
 * so the absorbing rule has to be enforced by the caller that owns the
 * transition.
 */
function isTerminalGoalStatus(status: GoalStatus): boolean {
  return status === 'done' || status === 'failed';
}

export class TaskAuctioneer {
  private readonly graph: KnowledgeGraph;
  private readonly fleet?: FleetBus | undefined;
  private readonly mailbox?: Mailbox | undefined;
  private readonly selfAgentId: string;
  private readonly bidWindowMs: number;
  private readonly maxTasksPerAgent: number;
  private readonly minConfidence: number; // minimum dispatcher confidence to accept a bid
  private readonly maxBidRetries: number; // max republished attempts before marking task failed

  /** Pending bids keyed by taskId. */
  private readonly pendingBids = new Map<string, TaskBid[]>();

  /** Active bid windows keyed by taskId. */
  private readonly bidTimers = new Map<string, NodeJS.Timeout>();

  /** FleetBus subscription disposers, detached in dispose(). */
  private readonly unsubs: Array<() => void> = [];

  /** How many times a task has been republished with no bids received. */
  private readonly bidRetryCounts = new Map<string, number>();

  /** Agent → current task count (from graph + in-flight). */
  private readonly agentTaskCounts = new Map<string, number>();

  constructor(opts: TaskAuctionOptions) {
    this.graph = opts.graph;
    this.fleet = opts.fleet;
    this.mailbox = opts.mailbox;
    this.selfAgentId = opts.selfAgentId ?? 'auctioneer';
    this.bidWindowMs = opts.bidWindowMs ?? 30_000;
    this.maxTasksPerAgent = opts.maxTasksPerAgent ?? 3;
    this.minConfidence = opts.minConfidence ?? 0.3;
    this.maxBidRetries = opts.maxBidRetries ?? 3;

    // Subscribe to fleet events for bid updates. Capture the disposers so a
    // coordinator stop/restart can detach them instead of leaking a handler
    // (and its captured `this`) on every cycle.
    const offBid = this.fleet?.filter('task:bid', (e) => this._onBidEvent(e));
    const offClaimed = this.fleet?.filter('task:claimed', (e) =>
      this._onClaimedEvent(e as { payload: { taskId: string } }),
    );
    if (offBid) this.unsubs.push(offBid);
    if (offClaimed) this.unsubs.push(offClaimed);
  }

  /**
   * Detach all FleetBus subscriptions and cancel any open bid-window timers.
   * Call when the owning coordinator stops/restarts so handlers and timers
   * don't accumulate across cycles.
   */
  dispose(): void {
    for (const off of this.unsubs.splice(0)) {
      try {
        off();
      } catch {
        /* best-effort */
      }
    }
    for (const t of this.bidTimers.values()) clearTimeout(t);
    this.bidTimers.clear();
  }

  // ── Publish a task ────────────────────────────────────────────────────

  /**
   * Publish a new task to the auction. Creates a GoalNode and broadcasts
   * it to all online agents. Returns the goal id.
   *
   * If `targetAgent` is specified, the task is assigned directly without auction.
   */
  async publishTask(input: {
    title: string;
    description: string;
    priority?: GoalPriority;
    tags?: string[];
    targetAgent?: string; // if set, assign directly (no auction)
    parentGoal?: string;
    satisfiesGoals?: string[];
    /** Goal ids that must reach 'done' before this goal becomes workable. */
    blockedBy?: string[];
    deadline?: string;
    reward?: string; // e.g. "$0.05 budget" — informational
  }): Promise<string> {
    // A goal that declares blockers starts blocked: it must NOT be biddable
    // until its blockers complete (complete() flips it to 'pending').
    const blockedBy = input.blockedBy ?? [];
    const hasOpenBlockers =
      blockedBy.length > 0 &&
      blockedBy.some((id) => (this.graph.get(id) as GoalNode | undefined)?.status !== 'done');
    // Create the goal node
    const goal = (await this.graph.add({
      type: 'goal',
      title: input.title,
      description: input.description,
      status: input.targetAgent ? 'in_progress' : hasOpenBlockers ? 'blocked' : 'pending',
      priority: input.priority ?? 'medium',
      assignee: input.targetAgent,
      blockedBy,
      dependsOn: input.satisfiesGoals ?? [],
      createdBy: this.selfAgentId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: input.tags ?? [],
      children: [],
      parentGoal: input.parentGoal,
    } as Omit<GoalNode, 'id'>)) as GoalNode;

    // Update parent goal's children list
    if (input.parentGoal) {
      const parent = this.graph.get(input.parentGoal) as GoalNode | undefined;
      if (parent) {
        await this.graph.update(input.parentGoal, {
          children: [...parent.children, goal.id],
        });
      }
    }

    // Register this goal as a child of each blocker so complete() — which walks
    // the completing goal's `children` to unblock dependents — can find it.
    for (const blockerId of blockedBy) {
      const blocker = this.graph.get(blockerId) as GoalNode | undefined;
      if (blocker && !blocker.children.includes(goal.id)) {
        await this.graph.update(blockerId, { children: [...blocker.children, goal.id] });
      }
    }

    // If targeting a specific agent, assign directly
    if (input.targetAgent) {
      await this._assignDirect(goal.id, input.targetAgent);
    } else {
      // Broadcast to all agents via fleet + mailbox
      await this._broadcastTask(goal);
      // Start the bid window
      this._startBidWindow(goal.id);
    }

    this._emit('task:published', {
      taskId: goal.id,
      title: goal.title,
      priority: goal.priority,
      tags: goal.tags,
    });

    return goal.id;
  }

  // ── Bid on a task ─────────────────────────────────────────────────────

  /**
   * Submit a bid for a task. Called by agents who want to work on it.
   * Returns true if the bid was accepted, false if the task was already claimed.
   */
  async bid(
    taskId: string,
    agent: {
      agentId: string;
      agentName: string;
      agentRole: string;
    },
    rationale: string,
  ): Promise<boolean> {
    const goal = this.graph.get(taskId) as GoalNode | undefined;
    if (goal?.type !== 'goal') return false;
    if (goal.status !== 'pending') return false;

    // Check agent capacity
    const currentCount = this._getAgentTaskCount(agent.agentId);
    if (currentCount >= this.maxTasksPerAgent) return false;

    // Score the bid using dispatcher
    const dispatchResult = await dispatchAgent(goal.description);
    const score = dispatchResult.confidence * (dispatchResult.role === agent.agentRole ? 1.2 : 1);

    // Reject bids below minimum confidence threshold
    if (score < this.minConfidence) return false;

    const bid: TaskBid = {
      id: randomUUID(),
      taskId,
      agentId: agent.agentId,
      agentName: agent.agentName,
      agentRole: agent.agentRole,
      score,
      rationale,
      submittedAt: new Date().toISOString(),
    };

    // Add bid to pending
    let bids = this.pendingBids.get(taskId);
    if (!bids) {
      bids = [];
      this.pendingBids.set(taskId, bids);
    }

    // Avoid duplicate bids from same agent
    const existingIdx = bids.findIndex((b) => b.agentId === agent.agentId);
    if (existingIdx >= 0) {
      bids[existingIdx] = bid; // update existing bid
    } else {
      bids.push(bid);
    }

    // Broadcast bid via fleet
    this._emit('task:bid', {
      taskId,
      bid: { ...bid, score: Math.round(score * 100) / 100 },
      agentName: agent.agentName,
    });

    // Cross-session: also publish via mailbox
    await this._mailboxPublish({
      type: 'note',
      subject: `[bid] ${agent.agentName} → ${goal.title}`,
      body: `${agent.agentName} (${agent.agentRole}) bidded on task "${goal.title}" (${goal.id})\nRationale: ${rationale}\nScore: ${score.toFixed(2)}`,
    });

    return true;
  }

  // ── Claim (award) a task ───────────────────────────────────────────────

  /**
   * Award a task to a specific agent. Called internally by the bid window
   * expiry, or can be called directly to force an award.
   */
  async claim(taskId: string, agentId: string, agentName: string): Promise<boolean> {
    const goal = this.graph.get(taskId) as GoalNode | undefined;
    if (goal?.type !== 'goal') return false;
    if (goal.status !== 'pending') return false;

    // Clear any bid window
    this._cancelBidWindow(taskId);

    // Update the goal
    await this.graph.update(taskId, {
      status: 'in_progress',
      assignee: agentId,
      updatedAt: new Date().toISOString(),
    });

    // Clear pending bids
    this.pendingBids.delete(taskId);

    // Update agent task count
    this.agentTaskCount(agentId, +1);

    // Notify the winner
    await this._notifyAgent(agentId, {
      type: 'assign',
      subject: `[assigned] ${goal.title}`,
      body: `You have been assigned: "${goal.title}"\n\n${goal.description}\n\nTask ID: ${taskId}\nPriority: ${goal.priority}`,
      taskContext: {
        agentRole: goal.tags[0],
        taskId,
        status: 'in_progress',
      },
    });

    this._emit('task:claimed', { taskId, agentId, agentName });

    return true;
  }

  // ── Complete a task ────────────────────────────────────────────────────

  /**
   * Mark a task as done. Called by the agent when it finishes.
   */
  async complete(taskId: string, _result?: string): Promise<void> {
    const goal = this.graph.get(taskId) as GoalNode | undefined;
    if (!goal) return;
    // Terminal states are absorbing: the first outcome wins. `KnowledgeGraph`
    // applies patches blindly, so without this a repeated or late report would
    // decrement the agent's in-flight count a second time — and because the
    // counter floors at zero rather than going negative, the agent would look
    // idler than it is and could be awarded past `maxTasksPerAgent`.
    if (isTerminalGoalStatus(goal.status)) return;

    const agentId = goal.assignee ?? 'unknown';
    this.agentTaskCount(agentId, -1);

    await this.graph.update(taskId, {
      status: 'done',
      updatedAt: new Date().toISOString(),
      ...(_result !== undefined ? { result: _result } : {}),
    });

    this.bidRetryCounts.delete(taskId);
    this.pendingBids.delete(taskId);
    this._cancelBidWindow(taskId);

    // Unblock any dependent goals
    for (const childId of goal.children) {
      const child = this.graph.get(childId) as GoalNode | undefined;
      // Only consider children still waiting on a blocker — never resurrect an
      // in-progress/done/failed child back to pending.
      if (child && child.status === 'blocked') {
        // Unblock only once EVERY blocker has reached 'done'.
        const allUnblocked = child.blockedBy.every((blockedId) => {
          const blocked = this.graph.get(blockedId) as GoalNode | undefined;
          return blocked?.status === 'done';
        });
        if (allUnblocked) {
          await this.graph.update(childId, {
            status: 'pending',
            updatedAt: new Date().toISOString(),
          });
          // Broadcast the newly unblocked task so agents know it's available
          const unblockedGoal = this.graph.get(childId) as GoalNode;
          await this._broadcastTask(unblockedGoal);
          // Start the bid window so _evaluateBids fires and awards the task to the best bidder
          this._startBidWindow(childId);
        }
      }
    }

    // Broadcast completion
    this._emit('task:completed', { taskId, agentId, result: _result });
    await this._mailboxPublish({
      type: 'result',
      subject: `[done] ${goal.title}`,
      body: `Task completed by ${agentId}: "${goal.title}"\n\n${_result ?? 'No result provided.'}`,
    });
  }

  /**
   * Mark a task as failed. Optionally spawn a retry.
   */
  async fail(taskId: string, error: string): Promise<void> {
    const goal = this.graph.get(taskId) as GoalNode | undefined;
    if (!goal) return;
    // Same absorbing rule as `complete`, and here it also protects the record
    // itself: a late failure report arriving after a genuine completion used to
    // rewrite a `done` task to `failed` and replace its result with the error.
    if (isTerminalGoalStatus(goal.status)) return;

    const agentId = goal.assignee ?? 'unknown';
    this.agentTaskCount(agentId, -1);

    await this.graph.update(taskId, {
      status: 'failed',
      updatedAt: new Date().toISOString(),
      result: error,
    });

    this.bidRetryCounts.delete(taskId);
    this.pendingBids.delete(taskId);
    this._cancelBidWindow(taskId);

    this._emit('task:failed', { taskId, agentId, error });
    await this._mailboxPublish({
      type: 'note',
      subject: `[failed] ${goal.title}`,
      body: `Task failed: "${goal.title}"\nError: ${error}\nAssignee: ${agentId}`,
    });
  }

  // ── Work finding ──────────────────────────────────────────────────────

  /**
   * Find the best available tasks for an agent based on its capabilities.
   * Returns tasks sorted by match score (best first).
   */
  async findWork(
    _agentId: string,
    agentRole: string,
    limit = 5,
  ): Promise<
    {
      task: GoalNode;
      score: number;
      bids: number;
    }[]
  > {
    const pending = this.graph.getGoals({ status: 'pending' });
    const scored: { task: GoalNode; score: number; bids: number }[] = [];

    for (const goal of pending) {
      // Skip if blocked
      if (goal.blockedBy.length > 0) continue;

      const dispatchResult = await dispatchAgent(goal.description);
      const roleBonus = agentRole && goal.tags.includes(agentRole) ? 1.3 : 1;
      const priorityBonus = goal.priority === 'critical' ? 1.5 : goal.priority === 'high' ? 1.2 : 1;
      const score = dispatchResult.confidence * roleBonus * priorityBonus;

      const bids = this.pendingBids.get(goal.id)?.length ?? 0;

      scored.push({ task: goal, score, bids });
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit);
  }

  // ── Queries ──────────────────────────────────────────────────────────

  /** Get all pending tasks (available for bidding). */
  getPendingTasks(): GoalNode[] {
    return this.graph.getGoals({ status: 'pending' }).filter((g) => g.blockedBy.length === 0);
  }

  /** Get tasks assigned to a specific agent. */
  getTasksForAgent(agentId: string): GoalNode[] {
    return this.graph.getGoals({}).filter((g) => g.assignee === agentId);
  }

  /** Get the current bid count for a task. */
  getBidCount(taskId: string): number {
    return this.pendingBids.get(taskId)?.length ?? 0;
  }

  /** Get bids for a task. */
  getBids(taskId: string): TaskBid[] {
    return this.pendingBids.get(taskId) ?? [];
  }

  /** Get task stats for a project-wide dashboard. */
  getStats(): {
    total: number;
    pending: number;
    in_progress: number;
    done: number;
    failed: number;
    totalBids: number;
    avgBidsPerTask: number;
  } {
    const all = this.graph.getGoals({});
    const pending = all.filter((g) => g.status === 'pending' && g.blockedBy.length === 0);
    const inProgress = all.filter((g) => g.status === 'in_progress');
    const done = all.filter((g) => g.status === 'done');
    const failed = all.filter((g) => g.status === 'failed');

    let totalBids = 0;
    for (const bids of this.pendingBids.values()) totalBids += bids.length;

    return {
      total: all.length,
      pending: pending.length,
      in_progress: inProgress.length,
      done: done.length,
      failed: failed.length,
      totalBids,
      avgBidsPerTask: pending.length > 0 ? totalBids / pending.length : 0,
    };
  }

  // ── Private ───────────────────────────────────────────────────────────

  private _emit(type: string, payload: Record<string, unknown>): void {
    if (!this.fleet) return;
    this.fleet.emit({ subagentId: this.selfAgentId, ts: Date.now(), type, payload });
  }

  private _broadcastTask(goal: GoalNode): void {
    this._emit('task:available', {
      taskId: goal.id,
      title: goal.title,
      description: goal.description,
      priority: goal.priority,
      tags: goal.tags,
    });

    // Cross-session via mailbox — use .catch(() => {}) not void.
    // void discards the return value but does NOT swallow promise rejections;
    // without .catch, any rejection from _mailboxPublish becomes an unhandled
    // promise rejection that crashes the process.
    this._mailboxPublish({
      type: 'broadcast',
      subject: `[task] ${goal.title} (${goal.priority})`,
      body: `New task available: "${goal.title}"\nPriority: ${goal.priority}\nDescription: ${goal.description.slice(0, 200)}${goal.description.length > 200 ? '...' : ''}\n\nTask ID: ${goal.id}\nTags: ${goal.tags.join(', ') || 'none'}\n\nBid by calling taskAuctioneer.bid("${goal.id}", ...)`,
    }).catch(
      /* v8 ignore next -- _mailboxPublish never rejects (it has its own catch); this outer catch is defensive. Arrow on its own line so v8 function-coverage excludes it. */
      () => {},
    );
  }

  private async _mailboxPublish(msg: {
    type: 'note' | 'broadcast' | 'result' | 'assign';
    subject: string;
    body: string;
    taskContext?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.mailbox) return;
    try {
      await this.mailbox.send({
        from: this.selfAgentId,
        to: '*',
        type: msg.type,
        subject: msg.subject,
        body: msg.body,
        priority: 'normal',
      });
    } catch {
      /* best-effort */
    }
  }

  private async _notifyAgent(
    agentId: string,
    msg: {
      type: 'assign' | 'note';
      subject: string;
      body: string;
      taskContext?: Record<string, unknown>;
    },
  ): Promise<void> {
    if (!this.mailbox) return;
    try {
      await this.mailbox.send({
        from: this.selfAgentId,
        to: agentId,
        type: msg.type,
        subject: msg.subject,
        body: msg.body,
        priority: 'high',
        taskContext: msg.taskContext as Parameters<typeof this.mailbox.send>[0]['taskContext'],
      });
    } catch {
      /* best-effort */
    }
  }

  private _startBidWindow(taskId: string): void {
    this._cancelBidWindow(taskId);
    const timer = setTimeout(() => {
      this.bidTimers.delete(taskId);
      // Fire-and-forget: the timer owns this promise, so swallow rejections
      // (e.g. a graph write that lands after the surrounding scope has torn
      // down — EPERM on a removed dir) instead of letting them escape as an
      // unhandled rejection that fails the whole run.
      /* v8 ignore next -- defensive: _evaluateBids catches its own errors */
      void this._evaluateBids(taskId).catch(() => {
        /* best-effort — bid window fired with nothing left to write to */
      });
    }, this.bidWindowMs);
    this.bidTimers.set(taskId, timer);
  }

  private _cancelBidWindow(taskId: string): void {
    const timer = this.bidTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.bidTimers.delete(taskId);
    }
  }

  private async _evaluateBids(taskId: string): Promise<void> {
    const bids = this.pendingBids.get(taskId);
    if (!bids || bids.length === 0) {
      // No bids received — check retry count
      const retryCount = (this.bidRetryCounts.get(taskId) ?? 0) + 1;
      this.bidRetryCounts.set(taskId, retryCount);

      if (retryCount >= this.maxBidRetries) {
        // Max retries exceeded — mark task as failed and give up
        await this.fail(taskId, `No bids received after ${this.maxBidRetries} attempts`);
        this.bidRetryCounts.delete(taskId);
        return;
      }

      // Republish with the current retry count as a hint
      const goal = this.graph.get(taskId) as GoalNode | undefined;
      if (goal) {
        await this._broadcastTask(goal);
        this._startBidWindow(taskId);
      }
      return;
    }

    // Sort by score descending, then award to the highest bidder still under
    // capacity. An agent may have won other tasks between bidding and the
    // window expiring, so re-check here (bid() only checks at bid time) to
    // avoid assigning beyond maxTasksPerAgent.
    bids.sort((a, b) => b.score - a.score);
    const winner = bids.find((b) => this._getAgentTaskCount(b.agentId) < this.maxTasksPerAgent);
    if (!winner) {
      // Every bidder is now at capacity — re-broadcast and try again later.
      const goal = this.graph.get(taskId) as GoalNode | undefined;
      if (goal) {
        await this._broadcastTask(goal);
        this._startBidWindow(taskId);
      }
      return;
    }

    await this.claim(taskId, winner.agentId, winner.agentName);
  }

  private async _assignDirect(taskId: string, agentId: string): Promise<void> {
    const goal = this.graph.get(taskId) as GoalNode | undefined;
    /* v8 ignore next -- always called with the just-created goal from publishTask */
    if (!goal) return;

    await this.graph.update(taskId, {
      status: 'in_progress',
      assignee: agentId,
      updatedAt: new Date().toISOString(),
    });

    this.agentTaskCount(agentId, +1);
    await this._notifyAgent(agentId, {
      type: 'assign',
      subject: `[assigned] ${goal.title}`,
      body: `You have been directly assigned: "${goal.title}"\n\n${goal.description}`,
      taskContext: { taskId, status: 'in_progress' },
    });
  }

  private _onBidEvent(_e: { payload: unknown }): void {
    // Already handled by bid() — fleet events from other sessions
    // trigger re-broadcast if the task is in this graph
  }

  private _onClaimedEvent(e: { payload: { taskId: string } }): void {
    const { taskId } = e.payload as { taskId: string };
    // Clear local bids for this task
    this.pendingBids.delete(taskId);
    this._cancelBidWindow(taskId);
  }

  private _getAgentTaskCount(agentId: string): number {
    return this.agentTaskCounts.get(agentId) ?? 0;
  }

  private agentTaskCount(agentId: string, delta: number): void {
    const current = this._getAgentTaskCount(agentId);
    const next = Math.max(0, current + delta);
    this.agentTaskCounts.set(agentId, next);
  }
}
