/**
 * ConsensusProtocol — agent voting on proposed changes.
 *
 * Enables autonomous approval of code changes without a human. Agents register
 * as voters with a role weight; changes gather votes; the protocol resolves
 * the outcome based on configured quorum rules.
 *
 * Voting rules (configurable):
 * - Quorum: minimum fraction of eligible voters required (default: 0.5)
 * - Approval threshold: minimum fraction of cast votes that must be approve (default: 0.6)
 * - Veto roles: roles whose 'reject' vote is fatal regardless of count
 * - Auto-approve: changes with severity=critical bypass voting if the proposer is trusted
 *
 * The protocol is stateless — it reads from the KnowledgeGraph and writes results
 * back to it. This makes it naturally consistent with the shared knowledge model.
 *
 * @module consensus-protocol
 */
import type { ChangeNode, VoteRecord, VoteValue } from './knowledge-graph.js';
import type { KnowledgeGraph } from './knowledge-graph.js';
import type { FleetBus } from './fleet-bus.js';

// ── Voter configuration ──────────────────────────────────────────────────

export interface VoterConfig {
  agentId: string;
  agentName: string;
  role: string;
  /** Weight multiplier for this voter's vote. Default: 1. */
  weight: number;
  /** If true, a 'reject' vote from this role is a hard veto. Default: false. */
  veto?: boolean;
  /**
   * @deprecated Not yet implemented. Auto-approve of low-risk changes is planned
   * but not wired up in the vote resolution logic.
   */
  autoApprovesLowRisk?: boolean;
}

export interface QuorumRule {
  /** Fraction of eligible voters required (0-1). Default: 0.5. */
  quorumFraction: number;
  /** Fraction of cast votes that must be approve (0-1). Default: 0.6. */
  approvalFraction: number;
  /** Roles whose reject vote is a hard veto regardless of count. */
  vetoRoles: string[];
  /** Minimum total weight of approve votes to pass (0-1 of total eligible weight). */
  approvalWeightFraction?: number | undefined;
}

export interface ConsensusResult {
  changeId: string;
  outcome: 'approved' | 'rejected' | 'pending' | 'vetoed' | 'quorum_not_met';
  votes: VoteRecord[];
  approveCount: number;
  rejectCount: number;
  abstainCount: number;
  totalWeightApprove: number;
  totalWeightReject: number;
  eligibleVoters: string[];
  quorumMet: boolean;
  approvalMet: boolean;
  vetoedBy?: string;
  rationale: string;
}

export interface ConsensusOptions {
  rules?: Partial<QuorumRule>;
  voters: VoterConfig[];
  graph: KnowledgeGraph;
  fleet?: FleetBus | undefined;
}

/**
 * ConsensusProtocol manages voting on ChangeNodes in the KnowledgeGraph.
 * It is instantiated once per autonomous session and used to initiate votes,
 * cast votes, and resolve outcomes.
 */
export class ConsensusProtocol {
  private readonly graph: KnowledgeGraph;
  private readonly fleet?: FleetBus | undefined;
  private readonly rules: QuorumRule;
  private readonly voters: Map<string, VoterConfig>; // agentId → config

  constructor(opts: ConsensusOptions) {
    this.graph = opts.graph;
    this.fleet = opts.fleet ?? undefined;
    this.voters = new Map(opts.voters.map((v) => [v.agentId, v]));
    this.rules = {
      quorumFraction: opts.rules?.quorumFraction ?? 0.5,
      approvalFraction: opts.rules?.approvalFraction ?? 0.6,
      vetoRoles: opts.rules?.vetoRoles ?? [],
      approvalWeightFraction: opts.rules?.approvalWeightFraction,
    };
  }

  // ── Vote lifecycle ────────────────────────────────────────────────────

  /**
   * Initiate a vote on a proposed change. Updates the change node's status
   * to 'proposed' and notifies eligible voters via FleetBus.
   */
  async initiateVote(changeId: string): Promise<void> {
    const change = this.graph.get(changeId) as ChangeNode | undefined;
    if (change?.type !== 'change') {
      throw new Error(`ConsensusProtocol: no change found with id "${changeId}"`);
    }
    if (change.status === 'approved' || change.status === 'rejected') {
      throw new Error(
        `ConsensusProtocol: cannot initiate vote on already resolved change "${changeId}" (status: "${change.status}")`,
      );
    }
    await this.graph.update(changeId, { status: 'proposed', votes: [] });
    const eligible = this._eligibleVoters(change);
    this._notifyVoters(change, eligible, 'vote_initiated');
  }

  /**
   * Cast a vote. Updates the change node in the graph and re-evaluates
   * consensus. If the vote triggers a resolution, updates the change status.
   */
  async castVote(
    changeId: string,
    voterId: string,
    value: VoteValue,
    rationale?: string,
  ): Promise<ConsensusResult> {
    const change = this.graph.get(changeId) as ChangeNode | undefined;
    if (change?.type !== 'change') {
      throw new Error(`ConsensusProtocol: no change found for "${changeId}"`);
    }

    if (change.status !== 'proposed') {
      throw new Error(
        `ConsensusProtocol: cannot cast vote on change "${changeId}" with status "${change.status}" (ballot is closed)`,
      );
    }

    const voter = this.voters.get(voterId);
    if (!voter) {
      throw new Error(`ConsensusProtocol: unknown voter "${voterId}"`);
    }

    const eligible = this._eligibleVoters(change);
    if (!eligible.includes(voterId)) {
      throw new Error(`ConsensusProtocol: voter "${voterId}" is not eligible for this vote`);
    }

    const vote: VoteRecord = {
      agentId: voterId,
      agentName: voter.agentName,
      value,
      rationale,
      votedAt: new Date().toISOString(),
    };

    // Update change node with new vote
    const existingIdx = change.votes.findIndex((v) => v.agentId === voterId);
    const newVotes =
      existingIdx >= 0 ? change.votes.with(existingIdx, vote) : [...change.votes, vote];

    const result = this._resolve(changeId, newVotes, eligible);

    // Update graph with votes and final status if resolved
    await this.graph.update(changeId, {
      votes: newVotes,
      ...(result.outcome !== 'pending' ? { status: this._toChangeStatus(result.outcome) } : {}),
    });

    // Notify all voters of the new vote and outcome
    this._notifyVoters(change, eligible, 'vote_cast', { voterId, value, result });

    return result;
  }

  /**
   * Resolve the current vote without waiting for all eligible voters.
   * Useful when a timeout fires or an agent decides to finalize early.
   */
  async resolveNow(changeId: string): Promise<ConsensusResult> {
    const change = this.graph.get(changeId) as ChangeNode | undefined;
    if (!change) throw new Error(`ConsensusProtocol: unknown change "${changeId}"`);
    const eligible = this._eligibleVoters(change);
    const result = this._resolve(changeId, change.votes, eligible);

    if (result.outcome !== 'pending') {
      await this.graph.update(changeId, { status: this._toChangeStatus(result.outcome) });
      this._notifyVoters(change, eligible, 'vote_resolved', { result });
    }

    return result;
  }

  /**
   * Register or update a voter's configuration.
   */
  registerVoter(config: VoterConfig): void {
    this.voters.set(config.agentId, config);
  }

  /**
   * Get the current vote status for a change.
   */
  getStatus(changeId: string): ConsensusResult | null {
    const change = this.graph.get(changeId) as ChangeNode | undefined;
    if (change?.type !== 'change') return null;
    const eligible = this._eligibleVoters(change);
    return this._resolve(changeId, change.votes, eligible);
  }

  // ── Private ───────────────────────────────────────────────────────────

  private _eligibleVoters(change: ChangeNode): string[] {
    // The proposer has a conflict of interest — they cannot vote on their own proposal.
    return Array.from(this.voters.keys()).filter((agentId) => agentId !== change.proposedBy);
  }

  private _resolve(changeId: string, votes: VoteRecord[], eligible: string[]): ConsensusResult {
    const totalEligible = eligible.length;

    const approve = votes.filter((v) => v.value === 'approve');
    const reject = votes.filter((v) => v.value === 'reject');
    const abstain = votes.filter((v) => v.value === 'abstain');

    const totalWeightApprove = approve.reduce(
      (sum, v) => sum + (this.voters.get(v.agentId)?.weight ?? 1),
      0,
    );
    const totalWeightReject = reject.reduce(
      (sum, v) => sum + (this.voters.get(v.agentId)?.weight ?? 1),
      0,
    );
    const totalWeight = eligible.reduce((sum, id) => sum + (this.voters.get(id)?.weight ?? 1), 0);

    const castCount = votes.length;
    const quorumRequired = Math.ceil(totalEligible * this.rules.quorumFraction);
    const quorumMet = castCount >= quorumRequired;

    // Check veto first
    for (const v of reject) {
      const config = this.voters.get(v.agentId);
      if (config?.veto && this.rules.vetoRoles.includes(config.role)) {
        return {
          changeId,
          outcome: 'vetoed',
          votes,
          approveCount: approve.length,
          rejectCount: reject.length,
          abstainCount: abstain.length,
          totalWeightApprove,
          totalWeightReject,
          eligibleVoters: eligible,
          quorumMet,
          approvalMet: false,
          vetoedBy: config.agentId,
          rationale: `Hard veto from role "${config.role}" (${config.agentName}).`,
        };
      }
    }

    if (!quorumMet) {
      return {
        changeId,
        outcome: 'quorum_not_met',
        votes,
        approveCount: approve.length,
        rejectCount: reject.length,
        abstainCount: abstain.length,
        totalWeightApprove,
        totalWeightReject,
        eligibleVoters: eligible,
        quorumMet: false,
        approvalMet: false,
        rationale: `Quorum not met: ${castCount}/${quorumRequired} required.`,
      };
    }

    const approvalRequired = Math.ceil(castCount * this.rules.approvalFraction);
    const approvalMet = approve.length >= approvalRequired;

    // Weight-based approval check
    if (this.rules.approvalWeightFraction !== undefined && approvalMet) {
      const weightRequired = totalWeight * this.rules.approvalWeightFraction;
      if (totalWeightApprove < weightRequired) {
        return {
          changeId,
          outcome: 'rejected',
          votes,
          approveCount: approve.length,
          rejectCount: reject.length,
          abstainCount: abstain.length,
          totalWeightApprove,
          totalWeightReject,
          eligibleVoters: eligible,
          quorumMet: true,
          approvalMet: false,
          rationale: `Weight threshold not met: ${totalWeightApprove.toFixed(2)}/${weightRequired.toFixed(2)} required.`,
        };
      }
    }

    if (approvalMet) {
      return {
        changeId,
        outcome: 'approved',
        votes,
        approveCount: approve.length,
        rejectCount: reject.length,
        abstainCount: abstain.length,
        totalWeightApprove,
        totalWeightReject,
        eligibleVoters: eligible,
        quorumMet: true,
        approvalMet: true,
        rationale: `Approved: ${approve.length}/${castCount} votes (threshold: ${approvalRequired}).`,
      };
    }

    return {
      changeId,
      outcome: 'rejected',
      votes,
      approveCount: approve.length,
      rejectCount: reject.length,
      abstainCount: abstain.length,
      totalWeightApprove,
      totalWeightReject,
      eligibleVoters: eligible,
      quorumMet: true,
      approvalMet: false,
      rationale: `Rejected: ${approve.length}/${castCount} approve votes (threshold: ${approvalRequired}).`,
    };
  }

  private _toChangeStatus(outcome: ConsensusResult['outcome']): ChangeNode['status'] {
    switch (outcome) {
      case 'approved':
        return 'approved';
      case 'rejected':
        return 'rejected';
      case 'vetoed':
        return 'rejected';
      case 'quorum_not_met':
        return 'proposed';
      default:
        return 'proposed';
    }
  }

  private _notifyVoters(
    change: ChangeNode,
    eligible: string[],
    event: string,
    extra?: Record<string, unknown>,
  ): void {
    if (!this.fleet) return;
    this.fleet.emit({
      subagentId: 'consensus',
      ts: Date.now(),
      type: `consensus:${event}`,
      payload: { changeId: change.id, changeTitle: change.title, eligible, ...extra },
    });
  }
}
