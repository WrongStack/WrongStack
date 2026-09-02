import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BrainDecisionCard,
  parseBrainMarkdown,
} from '../../src/components/ChatView/BrainDecisionCard';
import type { BrainDecisionData, ChatMessage } from '../../src/stores/types';

function createBrainMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  const brainDecision: BrainDecisionData = {
    id: 'req-brain-42',
    kind: 'intervention',
    intervened: true,
    decisionType: 'steer',
    question: 'Agent encountered consecutive tool execution failure loop on npm install',
    text: 'Switch package manager from npm to pnpm with frozen lockfile flag.',
    rationale:
      'The dependency resolution broke due to peer conflict; pnpm --frozen-lockfile bypasses dirty workspace state safely.',
    source: 'brain-monitor',
    risk: 'high',
    confidence: 0.94,
    at: 1000,
  };

  return {
    id: 'msg-brain-1',
    role: 'assistant',
    content:
      '🧠 **Brain intervention** — corrective guidance was sent to the agent.\n\nAgent encountered consecutive tool execution failure loop\n\n_Switch package manager from npm to pnpm_',
    timestamp: 1000,
    brainDecision,
    ...overrides,
  };
}

describe('BrainDecisionCard', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders intervention card with steering guidance and cognitive rationale', () => {
    const message = createBrainMessage();
    render(<BrainDecisionCard message={message} />);

    expect(screen.getByText('Brain Intervention')).toBeTruthy();
    expect(screen.getByText('req-brain-42')).toBeTruthy();
    expect(screen.getByText('Agent Steered')).toBeTruthy();
    expect(screen.getByText('High Risk')).toBeTruthy();
    expect(screen.getByText('brain-monitor')).toBeTruthy();
    expect(
      screen.getByText(/Switch package manager from npm to pnpm with frozen lockfile flag/i),
    ).toBeTruthy();
    expect(screen.getByText(/The dependency resolution broke due to peer conflict/i)).toBeTruthy();
    expect(screen.getByText('94%')).toBeTruthy();
  });

  it('renders denied card with policy block message', () => {
    const message: ChatMessage = {
      id: 'msg-brain-denied',
      role: 'assistant',
      content: '🧠 Denied: Arbitrary sudo access is prohibited',
      timestamp: 1000,
      brainDecision: {
        id: 'req-denied-1',
        kind: 'denied',
        decisionType: 'deny',
        question: 'Execute root shell script',
        reason: 'Arbitrary sudo access is prohibited by safety policy',
        risk: 'critical',
        source: 'policy',
      },
    };

    render(<BrainDecisionCard message={message} />);
    expect(screen.getByText('Brain Policy Guardrail')).toBeTruthy();
    expect(screen.getByText('Action Denied')).toBeTruthy();
    expect(screen.getByText('Critical Risk')).toBeTruthy();
    expect(screen.getByText(/Arbitrary sudo access is prohibited/i)).toBeTruthy();
  });

  it('renders ask_human escalation card', () => {
    const message: ChatMessage = {
      id: 'msg-brain-ask',
      role: 'assistant',
      content: '🧠 The Brain escalated this question back to you — it needs human judgement.',
      timestamp: 1000,
      brainDecision: {
        id: 'req-ask-1',
        kind: 'ask_human',
        decisionType: 'ask_human',
        question: 'Deploy database migration to production?',
        text: 'The Brain determined this decision exceeds autonomous authority and requires human input.',
        risk: 'high',
      },
    };

    render(<BrainDecisionCard message={message} />);
    expect(screen.getByText('Brain Human Escalation')).toBeTruthy();
    expect(screen.getByText('Human Required')).toBeTruthy();
    expect(screen.getByText('Deploy database migration to production?')).toBeTruthy();
  });

  it('parses legacy markdown gracefully when brainDecision object is omitted', () => {
    const legacyMessage: ChatMessage = {
      id: 'legacy-brain-1',
      role: 'assistant',
      content:
        '🧠 **Brain intervention** — corrective guidance was sent to the agent.\n\nRepeated timeout on test run\n\n_Increase timeout from 5000ms to 30000ms_',
      timestamp: 1000,
    };

    render(<BrainDecisionCard message={legacyMessage} />);
    expect(screen.getByText('Brain Intervention')).toBeTruthy();
    expect(screen.getByText('Repeated timeout on test run')).toBeTruthy();
    expect(screen.getByText(/Increase timeout from 5000ms to 30000ms/i)).toBeTruthy();
  });
});
