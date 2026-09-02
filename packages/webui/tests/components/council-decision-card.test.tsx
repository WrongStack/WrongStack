import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CouncilDecisionCard,
  parseCouncilMarkdown,
} from '../../src/components/ChatView/CouncilDecisionCard';
import type { ChatMessage, CouncilDecisionData } from '../../src/stores/types';

function createCouncilMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  const councilDecision: CouncilDecisionData = {
    requestId: 'req-council-100',
    phase: 'resolved',
    status: 'decided',
    resolution: 'consensus',
    optionId: 'merge',
    question: 'Should we auto-merge the verified refactoring PR?',
    reason: 'Quorum reached with high consensus',
    configuredSeatCount: 3,
    validVoteCount: 3,
    distinctTargetCount: 3,
    judgeUsed: false,
    durationMs: 1400,
    totalTokens: 620,
    seats: [
      {
        seatId: 'seat-1',
        persona: 'executor',
        status: 'valid',
        optionId: 'merge',
        stance: 'Looks completely safe and verified',
        rationale: 'All test suites passed without regressions.',
        providerId: 'anthropic',
        model: 'claude-3-5-sonnet',
        weight: 1.0,
        durationMs: 450,
        at: 1000,
      },
      {
        seatId: 'seat-2',
        persona: 'skeptic',
        status: 'valid',
        optionId: 'merge',
        stance: 'Edge cases covered properly',
        rationale: 'Checked concurrency locks and boundary tests.',
        providerId: 'openai',
        model: 'gpt-4o',
        weight: 1.0,
        durationMs: 480,
        at: 1000,
      },
      {
        seatId: 'seat-3',
        persona: 'auditor',
        status: 'valid',
        optionId: 'merge',
        stance: 'Compliance verified',
        rationale: 'No policy violations detected.',
        providerId: 'google',
        model: 'gemini-1.5-pro',
        weight: 1.0,
        durationMs: 420,
        at: 1000,
      },
    ],
  };

  return {
    id: 'msg-council-1',
    role: 'assistant',
    content:
      '⚖️ **Council resolved** · 3/3 seats · 3 distinct targets · 620 tok\n- **executor** → merge · `claude-3-5-sonnet`\n- **skeptic** → merge · `gpt-4o`\n- **auditor** → merge · `gemini-1.5-pro`',
    timestamp: 1000,
    councilDecision,
    ...overrides,
  };
}

describe('CouncilDecisionCard', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders structured CouncilDecisionData with header, question, and metrics', () => {
    const message = createCouncilMessage();
    render(<CouncilDecisionCard message={message} />);

    expect(screen.getByText(/Council Consensus/i)).toBeTruthy();
    expect(screen.getByText('req-council-100')).toBeTruthy();
    expect(screen.getByText('Should we auto-merge the verified refactoring PR?')).toBeTruthy();
    expect(screen.getByText('3/3 Valid')).toBeTruthy();
    expect(screen.getByText('3 Models')).toBeTruthy();
    expect(screen.getByText('1.4s')).toBeTruthy();
    expect(screen.getByText('620 tok')).toBeTruthy();
  });

  it('renders visual vote distribution chart and seat cards with models', () => {
    const message = createCouncilMessage();
    render(<CouncilDecisionCard message={message} />);

    expect(screen.getByText(/Consensus Voting Distribution/i)).toBeTruthy();
    expect(screen.getAllByText('merge').length).toBeGreaterThan(0);
    expect(screen.getByText('claude-3-5-sonnet')).toBeTruthy();
    expect(screen.getByText('gpt-4o')).toBeTruthy();
    expect(screen.getByText('gemini-1.5-pro')).toBeTruthy();
    expect(screen.getByText('executor')).toBeTruthy();
    expect(screen.getByText('skeptic')).toBeTruthy();
    expect(screen.getByText('auditor')).toBeTruthy();
  });

  it('expands and collapses voter rationale details', () => {
    const message = createCouncilMessage();
    render(<CouncilDecisionCard message={message} />);

    const rationaleButtons = screen.getAllByRole('button', { name: /Rationale/i });
    expect(rationaleButtons.length).toBeGreaterThan(0);

    // Expand the first seat's rationale
    fireEvent.click(rationaleButtons[0]!);
    expect(screen.getByText('All test suites passed without regressions.')).toBeTruthy();

    // Toggle collapse
    const hideButton = screen.getByRole('button', { name: /Hide/i });
    fireEvent.click(hideButton);
    expect(screen.queryByText('All test suites passed without regressions.')).toBeNull();
  });

  it('renders veto badge when a seat applies veto', () => {
    const message = createCouncilMessage({
      councilDecision: {
        requestId: 'req-veto-1',
        phase: 'resolved',
        status: 'denied',
        resolution: 'veto',
        optionId: 'deny',
        question: 'Deploy unverified hotfix?',
        configuredSeatCount: 2,
        validVoteCount: 2,
        distinctTargetCount: 2,
        seats: [
          {
            seatId: 's1',
            persona: 'executor',
            status: 'valid',
            optionId: 'deploy',
            model: 'gpt-4o',
            at: 1000,
          },
          {
            seatId: 's2',
            persona: 'skeptic',
            status: 'valid',
            optionId: 'deny',
            veto: true,
            model: 'claude-3-5-sonnet',
            at: 1000,
          },
        ],
      },
    });

    render(<CouncilDecisionCard message={message} />);
    expect(screen.getAllByText(/VETO/i).length).toBeGreaterThan(0);
  });

  it('renders judge tie-breaker section when judge is used', () => {
    const message = createCouncilMessage({
      councilDecision: {
        requestId: 'req-judge-1',
        phase: 'resolved',
        status: 'decided',
        resolution: 'judge',
        optionId: 'refactor',
        judgeUsed: true,
        judgeModel: 'claude-3-opus',
        judgeRationale: 'Judge decided refactoring was the safer long-term architecture.',
        seats: [
          { seatId: 's1', persona: 'voter1', status: 'valid', optionId: 'optA', at: 1000 },
          { seatId: 's2', persona: 'voter2', status: 'valid', optionId: 'optB', at: 1000 },
        ],
      },
    });

    render(<CouncilDecisionCard message={message} />);
    expect(screen.getByText(/Judicial Arbiter Tie-Breaker/i)).toBeTruthy();
    expect(screen.getByText('claude-3-opus')).toBeTruthy();
    expect(
      screen.getByText(/Judge decided refactoring was the safer long-term architecture/i),
    ).toBeTruthy();
  });

  it('parses legacy markdown seamlessly when councilDecision field is not present', () => {
    const legacyMessage: ChatMessage = {
      id: 'legacy-msg-1',
      role: 'assistant',
      content:
        '⚖️ **Council resolved** · 2/2 seats · 2 distinct targets\n- **executor** → allow · `gpt-4o`\n- **skeptic** (veto) → allow · `claude-3-5-sonnet`\n> ⚠ Panel has tight latency constraints',
      timestamp: 1000,
    };

    render(<CouncilDecisionCard message={legacyMessage} />);
    expect(screen.getByText(/Council Consensus/i)).toBeTruthy();
    expect(screen.getByText('executor')).toBeTruthy();
    expect(screen.getByText('skeptic')).toBeTruthy();
    expect(screen.getByText(/Panel has tight latency constraints/i)).toBeTruthy();
  });
});
