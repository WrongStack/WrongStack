/**
 * CouncilBrainArbiter — a multi-LLM decision panel for high-stakes questions.
 *
 * Instead of trusting one model's single completion, the council convenes N
 * independent voters (ideally different models/providers), each with a
 * distinct decision persona:
 *
 *   - executor — biased toward forward progress; hates stalling.
 *   - skeptic  — hunts for the reason the proposed action is wrong; may veto.
 *   - auditor  — cost/waste/budget lens; hates throwing tokens at dead ends.
 *
 * Votes are cast INDEPENDENTLY (no voter sees another's rationale), then
 * tallied with weights. Resolution ladder:
 *
 *   1. QUORUM  — fewer than `quorumFraction` of seats returned a valid vote
 *      → the council abstains (`ask_human`), letting the escalation tier
 *      (human prompt or headless terminal policy) resolve it.
 *   2. VETO    — a veto seat explicitly refusing denies the request outright.
 *   3. MAJORITY — the option with the highest total weight wins when it
 *      exceeds `approvalFraction` of all cast weight.
 *   4. JUDGE   — ties / weak pluralities go to a judge model that sees every
 *      vote's rationale and issues the final structured decision. No judge
 *      (or judge failure) → abstain (`ask_human`).
 *
 * Optionless (free-text) requests skip the tally: every voter writes an
 * independent stance and the judge synthesizes the final answer; without a
 * judge, the first valid stance wins.
 *
 * The council NEVER blocks on a human itself — its worst case is an
 * `ask_human` abstention that the outer escalation tier resolves.
 *
 * @module council-brain
 */

import type {
  BrainArbiter,
  BrainDecision,
  BrainDecisionOption,
  BrainDecisionRequest,
} from '../coordination/brain.js';
import { readBundledInstructionText } from '../utils/instruction-file.js';
import { resolveCouncilVotes } from './council-resolution.js';
import {
  type BrainLlmTarget,
  buildBrainUserMessage,
  completeBrainLlm,
  formatDecisionSummary,
  parseOptionDecision,
  withDecisionDigest,
} from './autonomy-brain.js';

/** One voting seat on the council. */
export interface CouncilVoter extends BrainLlmTarget {
  /**
   * Decision lens. Built-ins: 'executor', 'skeptic', 'auditor'. Any other
   * string is injected verbatim as the persona description.
   */
  persona?: string | undefined;
  /** Vote weight in the tally. Default 1. */
  weight?: number | undefined;
  /** When true, this seat's explicit refusal denies the request outright. */
  veto?: boolean | undefined;
}

export interface CouncilBrainOptions {
  voters: CouncilVoter[];
  /** Tie-breaker / synthesizer. Default: none (ties abstain to escalation). */
  judge?: BrainLlmTarget | undefined;
  /** Fraction of seats that must return a valid vote. Default 0.5. */
  quorumFraction?: number | undefined;
  /** Fraction of cast weight the winning option must EXCEED. Default 0.5. */
  approvalFraction?: number | undefined;
  /** Per-voter (and judge) completion timeout in ms. Default 15000. */
  decisionTimeoutMs?: number | undefined;
  /**
   * Decision-history digest (typically `BrainDecisionLedger.digestFor`) —
   * appended to every voter's user message so the panel sees how similar
   * past decisions turned out.
   */
  getDecisionDigest?: ((request: BrainDecisionRequest) => string | undefined) | undefined;
  /** Called with a human-readable summary after every council decision. */
  onDecision?:
    | ((summary: string, decision: BrainDecision, request: BrainDecisionRequest) => void)
    | undefined;
}

/**
 * Synthetic ballot entry that lets any voter refuse every real option. Kept
 * deliberately awkward so it can never collide with a caller option id; if
 * it somehow does, the synthetic entry is skipped for that request.
 */
export const COUNCIL_REFUSE_OPTION_ID = 'council_refuse';

const BUILTIN_PERSONAS: Record<string, string> = {
  executor:
    'PERSONA: You hold the EXECUTOR seat. You are biased toward forward ' +
    'progress — stalled work is the failure mode you exist to prevent. ' +
    'Favor the option that keeps the system moving, unless doing so is ' +
    'clearly reckless.',
  skeptic:
    'PERSONA: You hold the SKEPTIC seat. Your job is to find the concrete ' +
    'reason the proposed action is wrong, unsafe, or based on a false ' +
    'premise. If you find one, vote against it or refuse. Do not oppose ' +
    'for its own sake — a sound proposal deserves your vote.',
  auditor:
    'PERSONA: You hold the AUDITOR seat. You judge through the cost/waste ' +
    'lens: budget already burned, expected cost of each option, and the ' +
    'odds of throwing resources at a dead end. Prefer the option with the ' +
    'best expected value per token spent.',
};

interface CastVote {
  seatId: string;
  voter: CouncilVoter;
  optionId: string;
  rationale: string | undefined;
}

function personaText(persona: string | undefined): string {
  if (!persona) return BUILTIN_PERSONAS['executor'] ?? '';
  return BUILTIN_PERSONAS[persona] ?? `PERSONA: ${persona}`;
}

function voterLabel(voter: CouncilVoter, index: number): string {
  return voter.label ?? `${voter.persona ?? 'voter'}#${index + 1} (${voter.model})`;
}

/** Ballot shown to voters: the caller's options plus the refuse entry. */
function ballotOptions(request: BrainDecisionRequest): BrainDecisionOption[] {
  const options = request.options ?? [];
  if (options.some((o) => o.id === COUNCIL_REFUSE_OPTION_ID)) return options;
  return [
    ...options,
    {
      id: COUNCIL_REFUSE_OPTION_ID,
      label: 'Refuse — none of these options should be taken',
      consequence: 'The proposed action is not taken at all.',
    },
  ];
}

/**
 * Create a council-of-LLMs Brain arbiter. See the module docs for the
 * resolution ladder. Positioned by `createTieredBrainArbiter` above the
 * single-LLM tier for requests at/above the council risk floor.
 */
export function createCouncilBrainArbiter(opts: CouncilBrainOptions): BrainArbiter {
  if (opts.voters.length === 0) {
    throw new Error('createCouncilBrainArbiter: at least one voter is required.');
  }
  const quorumFraction = opts.quorumFraction ?? 0.5;
  const approvalFraction = opts.approvalFraction ?? 0.5;
  const timeoutMs = opts.decisionTimeoutMs ?? 15_000;
  const baseSystem = readBundledInstructionText('llm/autonomy-brain.md');

  const abstain = (request: BrainDecisionRequest, why: string): BrainDecision => ({
    type: 'ask_human',
    prompt: `Council abstained (${why}): ${request.question}`,
    options: request.options,
    rationale: `Council could not reach a decision: ${why}.`,
  });

  const finish = (request: BrainDecisionRequest, decision: BrainDecision): BrainDecision => {
    opts.onDecision?.(formatDecisionSummary(decision, request), decision, request);
    return decision;
  };

  async function collectVotes(
    request: BrainDecisionRequest,
    ballot: BrainDecisionOption[],
    digest: string | undefined,
  ): Promise<CastVote[]> {
    const ballotRequest: BrainDecisionRequest = { ...request, options: ballot };
    const user = withDecisionDigest(buildBrainUserMessage(ballotRequest), digest);
    const settled = await Promise.allSettled(
      opts.voters.map((voter) =>
        completeBrainLlm(voter, {
          system: `${baseSystem}\n\n${personaText(voter.persona)}`,
          user,
          timeoutMs,
        }),
      ),
    );
    const votes: CastVote[] = [];
    settled.forEach((result, i) => {
      const voter = opts.voters[i];
      if (!voter || result.status !== 'fulfilled') return;
      const parsed = parseOptionDecision(result.value, ballot);
      if (parsed?.type !== 'answer' || !parsed.optionId) return;
      votes.push({
        seatId: String(i),
        voter,
        optionId: parsed.optionId,
        rationale: parsed.rationale,
      });
    });
    return votes;
  }

  async function judgeRound(
    request: BrainDecisionRequest,
    ballot: BrainDecisionOption[],
    votes: CastVote[],
    reason: string,
  ): Promise<BrainDecision | null> {
    if (!opts.judge) return null;
    const voteLines = votes
      .map(
        (v, i) =>
          `- ${voterLabel(v.voter, i)} voted [${v.optionId}]` +
          (v.rationale ? ` — ${v.rationale}` : ''),
      )
      .join('\n');
    const judgeRequest: BrainDecisionRequest = {
      ...request,
      options: ballot,
      context: [
        request.context ?? '',
        '',
        `Council votes (${reason} — you are the judge; issue the final decision):`,
        voteLines,
      ]
        .join('\n')
        .trim(),
    };
    try {
      const text = await completeBrainLlm(opts.judge, {
        system:
          `${baseSystem}\n\nPERSONA: You are the council JUDGE. The voting ` +
          'seats disagreed or were too close to call. Weigh their rationales ' +
          'and issue the single final decision.',
        user: buildBrainUserMessage(judgeRequest),
        timeoutMs,
        maxTokens: 300,
      });
      const parsed = parseOptionDecision(text, ballot);
      if (parsed?.type === 'answer' && parsed.optionId) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  return {
    async decide(request: BrainDecisionRequest): Promise<BrainDecision> {
      const digest = opts.getDecisionDigest?.(request);

      // ── Optionless requests: independent stances + judge synthesis ────
      if (!request.options?.length) {
        const user = withDecisionDigest(buildBrainUserMessage(request), digest);
        const settled = await Promise.allSettled(
          opts.voters.map((voter) =>
            completeBrainLlm(voter, {
              system: `${baseSystem}\n\n${personaText(voter.persona)}`,
              user,
              timeoutMs,
            }),
          ),
        );
        const stances: Array<{ voter: CouncilVoter; text: string }> = [];
        settled.forEach((result, i) => {
          const voter = opts.voters[i];
          if (!voter || result.status !== 'fulfilled' || !result.value.trim()) return;
          stances.push({ voter, text: result.value.trim() });
        });
        if (stances.length / opts.voters.length < quorumFraction) {
          return finish(request, abstain(request, 'quorum not met'));
        }
        if (opts.judge) {
          const stanceLines = stances
            .map((s, i) => `- ${voterLabel(s.voter, i)}: ${s.text}`)
            .join('\n');
          try {
            const text = await completeBrainLlm(opts.judge, {
              system:
                `${baseSystem}\n\nPERSONA: You are the council JUDGE. ` +
                'Synthesize the seats’ independent stances below into the ' +
                'single final decision (1-2 sentences).',
              user: `${buildBrainUserMessage(request)}\n\nCouncil stances:\n${stanceLines}`,
              timeoutMs,
              maxTokens: 300,
            });
            if (text) {
              return finish(request, {
                type: 'answer',
                text,
                rationale: `Council synthesis of ${stances.length}/${opts.voters.length} stances.`,
              });
            }
          } catch {
            // Judge unavailable — fall through to the first stance below.
          }
        }
        const first = stances[0];
        if (first) {
          return finish(request, {
            type: 'answer',
            text: first.text,
            rationale: `Council (no judge): stance of ${voterLabel(first.voter, 0)}.`,
          });
        }
        return finish(request, abstain(request, 'no usable stance'));
      }

      // ── Option-bearing requests: independent votes + weighted tally ───
      const ballot = ballotOptions(request);
      const votes = await collectVotes(request, ballot, digest);

      const resolution = resolveCouncilVotes({
        seats: opts.voters.map((voter, i) => ({
          id: String(i),
          weight: voter.weight,
          veto: voter.veto,
        })),
        votes: votes.map((vote) => ({ seatId: vote.seatId, optionId: vote.optionId })),
        refusalOptionId: COUNCIL_REFUSE_OPTION_ID,
        quorumFraction,
        approvalFraction,
      });

      if (resolution.status === 'abstained') {
        return finish(
          request,
          abstain(
            request,
            `quorum not met (${resolution.validVoteCount}/${resolution.seatCount} votes)`,
          ),
        );
      }

      if (resolution.status === 'denied' && resolution.method === 'veto') {
        const vetoRefusal = votes.find((vote) => vote.seatId === resolution.seatId);
        if (!vetoRefusal) {
          return finish(request, abstain(request, 'veto ballot could not be resolved'));
        }
        return finish(request, {
          type: 'deny',
          reason:
            `Council veto by ${voterLabel(vetoRefusal.voter, 0)}` +
            (vetoRefusal.rationale ? `: ${vetoRefusal.rationale}` : '.'),
        });
      }

      let finalOptionId =
        resolution.status === 'decided' || resolution.status === 'denied'
          ? resolution.optionId
          : null;
      let viaJudge = false;
      if (resolution.status === 'needs_judge') {
        const judged = await judgeRound(
          request,
          ballot,
          votes,
          resolution.reason === 'tie' ? 'tie' : 'no option cleared the approval threshold',
        );
        if (judged?.type === 'answer' && judged.optionId) {
          finalOptionId = judged.optionId;
          viaJudge = true;
        }
      }
      if (!finalOptionId) {
        return finish(request, abstain(request, 'split vote and no judge verdict'));
      }

      const supporting = votes.filter((v) => v.optionId === finalOptionId);
      const voteSummary = votes
        .map((v, i) => `${voterLabel(v.voter, i)}→[${v.optionId}]`)
        .join(', ');
      const rationale =
        (supporting.find((v) => v.rationale)?.rationale ?? '') +
        ` (council${viaJudge ? ' via judge' : ''}: ${voteSummary})`;

      if (finalOptionId === COUNCIL_REFUSE_OPTION_ID) {
        return finish(request, {
          type: 'deny',
          reason: `Council refused the proposed action.${rationale}`,
        });
      }
      const option = request.options.find((o) => o.id === finalOptionId);
      return finish(request, {
        type: 'answer',
        optionId: finalOptionId,
        text: option?.label ?? finalOptionId,
        rationale: rationale.trim(),
      });
    },
  };
}
