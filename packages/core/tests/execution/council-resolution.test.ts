import { describe, expect, it } from 'vitest';
import {
  type CouncilResolutionInput,
  resolveCouncilVotes,
} from '../../src/execution/council-resolution.js';

const REFUSE = 'refuse';

function resolve(overrides: Partial<CouncilResolutionInput> = {}) {
  return resolveCouncilVotes({
    seats: [{ id: 'executor' }, { id: 'skeptic', veto: true }, { id: 'auditor' }],
    votes: [
      { seatId: 'executor', optionId: 'merge' },
      { seatId: 'skeptic', optionId: 'hold' },
      { seatId: 'auditor', optionId: 'merge' },
    ],
    refusalOptionId: REFUSE,
    quorumFraction: 0.5,
    approvalFraction: 0.5,
    ...overrides,
  });
}

describe('resolveCouncilVotes', () => {
  it('returns the uncontested weighted-majority winner', () => {
    expect(resolve()).toMatchObject({
      status: 'decided',
      method: 'majority',
      optionId: 'merge',
      winningWeight: 2,
      castWeight: 3,
    });
  });

  it('lets weight overrule seat count', () => {
    expect(
      resolve({
        seats: [{ id: 'executor', weight: 3 }, { id: 'skeptic' }, { id: 'auditor' }],
        votes: [
          { seatId: 'executor', optionId: 'hold' },
          { seatId: 'skeptic', optionId: 'merge' },
          { seatId: 'auditor', optionId: 'merge' },
        ],
      }),
    ).toMatchObject({ status: 'decided', optionId: 'hold', winningWeight: 3, castWeight: 5 });
  });

  it('abstains below quorum and reports participation', () => {
    expect(
      resolve({
        votes: [{ seatId: 'executor', optionId: 'merge' }],
        quorumFraction: 0.5,
      }),
    ).toEqual({
      status: 'abstained',
      reason: 'quorum_not_met',
      validVoteCount: 1,
      seatCount: 3,
    });
  });

  it('does not let duplicate or unknown seat votes inflate quorum or weight', () => {
    expect(
      resolve({
        votes: [
          { seatId: 'executor', optionId: 'merge' },
          { seatId: 'executor', optionId: 'merge' },
          { seatId: 'unknown', optionId: 'merge' },
        ],
        quorumFraction: 0.5,
      }),
    ).toMatchObject({ status: 'abstained', validVoteCount: 1 });
  });

  it('lets a veto seat refusal deny immediately', () => {
    expect(
      resolve({
        votes: [
          { seatId: 'executor', optionId: 'merge' },
          { seatId: 'skeptic', optionId: REFUSE },
          { seatId: 'auditor', optionId: 'merge' },
        ],
      }),
    ).toEqual({
      status: 'denied',
      method: 'veto',
      optionId: REFUSE,
      seatId: 'skeptic',
    });
  });

  it('denies when refusal wins without a veto', () => {
    expect(
      resolve({
        seats: [{ id: 'one' }, { id: 'two' }, { id: 'three' }],
        votes: [
          { seatId: 'one', optionId: REFUSE },
          { seatId: 'two', optionId: REFUSE },
          { seatId: 'three', optionId: 'merge' },
        ],
      }),
    ).toMatchObject({ status: 'denied', method: 'refusal', optionId: REFUSE });
  });

  it('sends an exact tie to the judge', () => {
    expect(
      resolve({
        seats: [{ id: 'one' }, { id: 'two' }],
        votes: [
          { seatId: 'one', optionId: 'merge' },
          { seatId: 'two', optionId: 'hold' },
        ],
      }),
    ).toEqual({ status: 'needs_judge', reason: 'tie', castWeight: 2 });
  });

  it('requires the winner to strictly exceed the approval threshold', () => {
    expect(
      resolve({
        seats: [{ id: 'one' }, { id: 'two' }, { id: 'three' }, { id: 'four' }],
        votes: [
          { seatId: 'one', optionId: 'merge' },
          { seatId: 'two', optionId: 'merge' },
          { seatId: 'three', optionId: 'hold' },
          { seatId: 'four', optionId: REFUSE },
        ],
        approvalFraction: 0.5,
      }),
    ).toEqual({
      status: 'needs_judge',
      reason: 'approval_threshold_not_met',
      castWeight: 4,
    });
  });

  it.each([
    [{ seats: [] }, /at least one seat/],
    [{ quorumFraction: 0 }, /quorumFraction/],
    [{ approvalFraction: 1.1 }, /approvalFraction/],
    [{ seats: [{ id: 'one', weight: 0 }] }, /invalid weight/],
    [{ seats: [{ id: 'same' }, { id: 'same' }] }, /duplicate seat id/],
  ] as const)('validates malformed inputs', (overrides, expected) => {
    expect(() => resolve(overrides)).toThrow(expected);
  });
});
