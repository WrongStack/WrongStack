import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatRowView } from '../../src/components/ChatView/ChatRowView';
import type { ChatRow } from '../../src/components/ChatView/utils';
import type { BrainDecisionData, ChatMessage, CouncilDecisionData } from '../../src/stores/types';

describe('ChatRowView decision widgets', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders CouncilDecisionCard when message has councilDecision', () => {
    const councilDecision: CouncilDecisionData = {
      requestId: 'req-row-council',
      status: 'decided',
      resolution: 'consensus',
      optionId: 'approve',
      question: 'Allow file modification on src/core.ts?',
      configuredSeatCount: 2,
      validVoteCount: 2,
      distinctTargetCount: 2,
      seats: [
        {
          seatId: 's1',
          persona: 'executor',
          status: 'valid',
          optionId: 'approve',
          model: 'gpt-4o',
          at: 1000,
        },
        {
          seatId: 's2',
          persona: 'skeptic',
          status: 'valid',
          optionId: 'approve',
          model: 'claude-3-5-sonnet',
          at: 1000,
        },
      ],
    };

    const message: ChatMessage = {
      id: 'msg-c1',
      role: 'assistant',
      content: 'Council message fallback',
      timestamp: 1000,
      councilDecision,
    };

    const row: ChatRow = {
      kind: 'agent',
      key: 'row-1',
      isLastTurn: true,
      items: [
        {
          kind: 'msg',
          key: 'item-1',
          message,
          isFirst: true,
          isContinuation: false,
        },
      ],
    };

    render(
      <ChatRowView
        row={row}
        isLoading={false}
        compactMode={false}
        isFirstRow={true}
        groupToolCalls={true}
        sessionId="sess-1"
      />,
    );

    expect(screen.getByText(/Council Consensus/i)).toBeTruthy();
    expect(screen.getByText('Allow file modification on src/core.ts?')).toBeTruthy();
    expect(screen.getByText('gpt-4o')).toBeTruthy();
    expect(screen.getByText('claude-3-5-sonnet')).toBeTruthy();
  });

  it('renders BrainDecisionCard when message has brainDecision', () => {
    const brainDecision: BrainDecisionData = {
      id: 'req-row-brain',
      kind: 'intervention',
      intervened: true,
      decisionType: 'steer',
      question: 'High token budget consumption detected',
      text: 'Apply summary compaction before continuing exploration.',
      risk: 'medium',
      source: 'brain-monitor',
    };

    const message: ChatMessage = {
      id: 'msg-b1',
      role: 'assistant',
      content: 'Brain message fallback',
      timestamp: 1000,
      brainDecision,
    };

    const row: ChatRow = {
      kind: 'agent',
      key: 'row-2',
      isLastTurn: true,
      items: [
        {
          kind: 'msg',
          key: 'item-2',
          message,
          isFirst: true,
          isContinuation: false,
        },
      ],
    };

    render(
      <ChatRowView
        row={row}
        isLoading={false}
        compactMode={false}
        isFirstRow={true}
        groupToolCalls={true}
        sessionId="sess-1"
      />,
    );

    expect(screen.getByText('Brain Intervention')).toBeTruthy();
    expect(screen.getByText('High token budget consumption detected')).toBeTruthy();
    expect(
      screen.getByText(/Apply summary compaction before continuing exploration/i),
    ).toBeTruthy();
  });
});
