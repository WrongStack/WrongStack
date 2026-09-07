import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomRosterPanel, setCustomRosterWS } from '../../src/components/CustomRosterPanel.js';

class MockWebSocket {
  readyState = 1; // WebSocket.OPEN
  listeners: Record<string, ((event: { data: string }) => void)[]> = {};

  addEventListener(event: string, fn: (event: { data: string }) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  removeEventListener(event: string, fn: (event: { data: string }) => void) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter((f) => f !== fn);
  }

  emit(data: unknown) {
    const event = { data: JSON.stringify(data) };
    for (const fn of this.listeners['message'] || []) {
      fn(event);
    }
  }

  send = vi.fn((dataStr: string) => {
    const parsed = JSON.parse(dataStr);
    // Queue response in next microtask
    queueMicrotask(() => {
      if (parsed.type === 'agent-roster.list') {
        this.emit({
          type: 'agent-roster.list',
          payload: {
            roles: ['architect'],
            stats: [
              {
                role: 'architect',
                exists: true,
                entryCount: 5,
                totalBytes: 1200,
                lastCapture: null,
                cooldownRemainingMs: 0,
                sessionCaptureCount: 1,
                needsSummarization: false,
                hasIdentity: true,
                hasConfig: true,
                hasKnowledge: false,
              },
            ],
          },
        });
      } else if (parsed.type === 'agent-roster.conflicts') {
        this.emit({
          type: 'agent-roster.conflicts',
          payload: {
            conflicts: [
              {
                roleA: 'architect',
                roleB: 'reviewer',
                similarity: 0.88,
              },
            ],
          },
        });
      } else if (parsed.type === 'agent-roster.stats') {
        this.emit({
          type: 'agent-roster.stats',
          payload: {
            role: 'architect',
            exists: true,
            entryCount: 5,
            totalBytes: 1200,
            lastCapture: null,
            cooldownRemainingMs: 0,
            sessionCaptureCount: 1,
            needsSummarization: false,
            hasIdentity: true,
            hasConfig: true,
            hasKnowledge: false,
          },
        });
      } else if (parsed.type === 'agent-roster.update-identity') {
        this.emit({
          type: 'agent-roster.update-identity',
          payload: { success: true },
        });
      } else if (parsed.type === 'agent-roster.append-learned') {
        this.emit({
          type: 'agent-roster.append-learned',
          payload: { success: true, path: 'learned.md' },
        });
      } else if (parsed.type === 'agent-roster.llm-improve') {
        this.emit({
          type: 'agent-roster.llm-improve',
          payload: { instruction: 'Improve architecture diagram guidelines' },
        });
      } else if (parsed.type === 'agent-roster.capture') {
        this.emit({
          type: 'agent-roster.capture',
          payload: { captured: 1 },
        });
      } else if (parsed.type === 'agent-roster.reset') {
        this.emit({
          type: 'agent-roster.reset',
          payload: { success: true },
        });
      }
    });
  });
}

describe('CustomRosterPanel', () => {
  let mockWs: MockWebSocket;

  beforeEach(() => {
    mockWs = new MockWebSocket();
    setCustomRosterWS(mockWs as unknown as WebSocket);
  });

  afterEach(() => {
    setCustomRosterWS(null);
    cleanup();
  });

  it('renders loading state initially and then displays roster roles and details', async () => {
    render(<CustomRosterPanel projectRoot="/test/project" />);

    await waitFor(() => {
      expect(screen.getByText('architect')).toBeTruthy();
    });

    expect(screen.getByText('1200B')).toBeTruthy();

    // Select the architect role
    const roleBtn = screen.getByRole('button', { name: /architect/i });
    fireEvent.click(roleBtn);

    // Detail header and stats
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'architect' })).toBeTruthy();
    });

    // Check action buttons in header (capture, reset)
    expect(screen.getByTitle(/Capture learned/i)).toBeTruthy();
    expect(screen.getByTitle(/Reset/i)).toBeTruthy();
  });

  it('allows teaching the agent new behaviors', async () => {
    const { container } = render(<CustomRosterPanel projectRoot="/test/project" />);

    await waitFor(() => {
      expect(screen.getByText('architect')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /architect/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'architect' })).toBeTruthy();
    });

    // Teach textarea is the first textarea on the page
    const textareas = container.querySelectorAll('textarea');
    expect(textareas.length).toBeGreaterThanOrEqual(2);
    fireEvent.change(textareas[0], {
      target: { value: 'Always enforce hexagonal architecture' },
    });

    const teachBtn = screen.getByRole('button', { name: /Teach/i });
    fireEvent.click(teachBtn);

    await waitFor(() => {
      expect(mockWs.send).toHaveBeenCalledWith(
        expect.stringContaining('agent-roster.append-learned'),
      );
    });
  });

  it('allows running LLM improve suggestions', async () => {
    const { container } = render(<CustomRosterPanel projectRoot="/test/project" />);

    await waitFor(() => {
      expect(screen.getByText('architect')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /architect/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'architect' })).toBeTruthy();
    });

    // LLM improve textarea is the second textarea on the page
    const textareas = container.querySelectorAll('textarea');
    expect(textareas.length).toBeGreaterThanOrEqual(2);
    fireEvent.change(textareas[1], {
      target: { value: 'Add strict review checks' },
    });

    const improveBtn = screen.getByRole('button', { name: /Improve/i });
    fireEvent.click(improveBtn);

    await waitFor(() => {
      expect(screen.getByText(/Improve architecture diagram guidelines/i)).toBeTruthy();
    });
  });

  it('renders empty state when there are no customized roles', async () => {
    mockWs.send.mockImplementationOnce((_dataStr: string) => {
      queueMicrotask(() => {
        mockWs.emit({
          type: 'agent-roster.list',
          payload: { roles: [], stats: [] },
        });
      });
    });

    render(<CustomRosterPanel projectRoot="/test/project" />);

    await waitFor(() => {
      expect(screen.getByText(/No Custom Roster Agents/i)).toBeTruthy();
    });

    expect(screen.getByText(/Create executor identity/i)).toBeTruthy();
  });

  it('renders error state when WebSocket connection is not available', async () => {
    setCustomRosterWS(null);

    render(<CustomRosterPanel projectRoot="/test/project" />);

    await waitFor(() => {
      expect(screen.getByText(/WebSocket not connected/i)).toBeTruthy();
    });
  });
});
