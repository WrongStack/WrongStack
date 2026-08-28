import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { wsSendMessage } = vi.hoisted(() => ({ wsSendMessage: vi.fn() }));

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({
    on: () => () => {},
    sendMessage: wsSendMessage,
    getChimeraReports: () => {},
  }),
}));

import { ChimeraReportCard } from '../../src/components/ChatView/ChimeraReportCard';
import {
  chatLane,
  DEFAULT_LANE_ID,
  ensureLane,
  readLane,
  useChatLanes,
} from '../../src/stores/chat-lanes';
import { useChimeraReportsStore } from '../../src/stores/chimera-reports-store';
import type { ChatMessage } from '../../src/stores/types';

const SESSION = 'sess-1';

function cardMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg_card_1',
    role: 'system',
    content: '🦂 Chimera report ready — 2 potential finding(s).',
    timestamp: 1_000,
    chimeraReport: { reportId: 'report-1', actionable: true, actionedAt: null },
    ...overrides,
  };
}

function renderCard(message: ChatMessage): void {
  render(<ChimeraReportCard message={message} sessionId={SESSION} />);
}

describe('ChimeraReportCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChimeraReportsStore.setState({ bySession: {} });
    useChatLanes.setState({ lanes: {}, activeSessionId: DEFAULT_LANE_ID });
    ensureLane(SESSION);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the report summary and the action affordance', () => {
    renderCard(cardMessage());
    expect(screen.getByText('Chimera report — action needed')).toBeTruthy();
    expect(screen.getByText(/2 potential finding/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Take action/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open in Chimera Hub/ })).toBeTruthy();
  });

  it('disables the button while the lane is busy (leader running)', () => {
    chatLane(SESSION).patch({ isLoading: true });
    renderCard(cardMessage());
    const button = screen.getByRole('button', { name: /Leader is running/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Leader is running');
  });

  it('one click auto-submits the prompt to this tab leader and marks the card sent', () => {
    const message = cardMessage();
    chatLane(SESSION).addMessage(message);
    renderCard(message);

    fireEvent.click(screen.getByRole('button', { name: /Take action/ }));

    // Prompt goes to THIS session's leader via the session-tagged send.
    expect(wsSendMessage).toHaveBeenCalledTimes(1);
    const [content, images, freshContext, targetSession] = wsSendMessage.mock.calls[0] as [
      string,
      unknown,
      boolean,
      string | undefined,
    ];
    expect(content).toContain('Take a look at the tasks mentioned in this Chimera report');
    expect(content).toContain('report-1');
    expect(images).toBeUndefined();
    expect(freshContext).toBe(false);
    expect(targetSession).toBe(SESSION);

    // The prompt itself is visible in the transcript as a user message.
    const lane = readLane(SESSION);
    const userPrompt = lane.messages.find((m) => m.role === 'user');
    expect(userPrompt?.content).toBe(content);
    // Lane is marked busy exactly like a typed send would.
    expect(lane.isLoading).toBe(true);
    // Card flips to its sent state and cannot fire twice.
    const card = lane.messages.find((m) => m.chimeraReport);
    expect(card?.chimeraReport?.actionedAt).not.toBeNull();
    expect(useChimeraReportsStore.getState().bySession[SESSION]?.[0]?.actionedAt).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Leader is running/ }));
    expect(wsSendMessage).toHaveBeenCalledTimes(1);
  });

  it('renders an already-actioned card in its terminal sent state', () => {
    renderCard(
      cardMessage({
        chimeraReport: { reportId: 'report-1', actionable: true, actionedAt: 2_000 },
      }),
    );
    const button = screen.getByRole('button', { name: /Prompt sent/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Prompt sent');
  });
});
