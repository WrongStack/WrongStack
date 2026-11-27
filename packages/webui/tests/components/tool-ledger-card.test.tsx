import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browserBlockedOrigin } from '../../src/components/MessageBubble/BrowserOriginApproval.js';
import { ToolLedgerCard } from '../../src/components/MessageBubble/ToolLedgerCard.js';
import type { ChatMessage } from '../../src/stores/types.js';

const ws = vi.hoisted(() => ({
  send: vi.fn(() => true),
  withSession: vi.fn((payload: Record<string, unknown>) => ({
    ...payload,
    sessionId: 'session-1',
  })),
}));

vi.mock('../../src/lib/ws-client.js', () => ({ getWSClient: () => ws }));

const message: ChatMessage = {
  id: 'tool-1',
  role: 'tool',
  content: '',
  timestamp: 1,
  toolName: 'bash',
  toolInput: { command: 'pnpm test', cwd: 'packages/webui' },
  toolResult: 'Tests passed',
  toolDurationMs: 1200,
  toolOutputBytes: 2048,
  toolOutputTokens: 585,
  toolOutputLines: 19,
};

describe('<ToolLedgerCard />', () => {
  beforeEach(() => {
    ws.send.mockClear();
    ws.withSession.mockClear();
  });

  it.each(['tool_script', 'tool_use'])(
    'shows ToolFlow identity and measured output for %s',
    (route) => {
      const script = 'return await tools.read({ path: "a.ts" });';
      const result = 'answer\n\n(2 tool calls: read ×2)\n\nToolFlow bytes: 20000 -> 40; calls: 2';
      render(
        <ToolLedgerCard
          message={{
            ...message,
            toolName: route,
            toolInput:
              route === 'tool_script'
                ? { script, description: 'Summarize a file' }
                : { tool: 'tool_script', input: { script, description: 'Summarize a file' } },
            toolResult:
              route === 'tool_script' ? result : JSON.stringify({ tool: 'tool_script', result }),
          }}
        />,
      );
      expect(screen.getByText('WrongStack ToolFlow')).toBeTruthy();
      expect(screen.getByText('ToolFlow · Summarize a file · 1 script line')).toBeTruthy();
      expect(screen.getByLabelText('ToolFlow measured output').textContent).toContain(
        '2 calls · 20000 B tool results',
      );
      fireEvent.click(screen.getByRole('button', { name: /WrongStack ToolFlow/ }));
      expect(screen.getByRole('region', { name: 'WrongStack ToolFlow overview' })).toBeTruthy();
      expect(
        screen.getByText(
          'Compose tools. Return answers. Each tool call keeps its own permission checks.',
        ),
      ).toBeTruthy();
      expect(
        screen.getByRole('region', { name: 'WrongStack ToolFlow overview' }).querySelector('pre')
          ?.textContent,
      ).toBe(script);
    },
  );
  it('shows explicit success metadata and keeps the generic input/output behind Details', () => {
    render(<ToolLedgerCard message={message} />);
    expect(screen.getByText('Succeeded')).toBeTruthy();
    expect(screen.getByText('1.20s')).toBeTruthy();
    expect(screen.getByText('2.0 KiB')).toBeTruthy();
    expect(screen.getByText('~585 tok')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /bash/i }));
    expect(screen.getByText('Command run')).toBeTruthy();
    expect(screen.getByText('Details')).toBeTruthy();
    expect(screen.getAllByText('pnpm test')).toHaveLength(2);
    expect(screen.getByText('Tests passed')).toBeTruthy();
  });

  it('names error and live states instead of relying on the status color alone', () => {
    const { rerender } = render(<ToolLedgerCard message={{ ...message, isError: true }} />);
    expect(screen.getByText('Failed')).toBeTruthy();

    rerender(<ToolLedgerCard message={{ ...message, toolResult: undefined }} />);
    expect(screen.getByText('Running')).toBeTruthy();
  });

  it('offers the blocked browser origin and sends the project approval through the host', () => {
    const origin = 'http://127.0.0.1:41789';
    const toolResult = `browser: blocked private target. Allow this project origin with /browser allow ${origin}`;
    render(
      <ToolLedgerCard
        message={{ ...message, toolName: 'browser_open', toolResult, isError: true }}
      />,
    );

    expect(browserBlockedOrigin('browser_open', toolResult, true)).toBe(origin);
    fireEvent.click(screen.getByRole('button', { name: 'Allow access' }));

    expect(ws.withSession).toHaveBeenCalledWith({ args: `allow ${origin}` });
    expect(ws.send).toHaveBeenCalledWith({
      type: 'browser.policy',
      payload: { args: `allow ${origin}`, sessionId: 'session-1' },
    });
    expect(screen.getByText('In Progress')).toBeTruthy();
  });

  it('does not expose approvals for non-browser errors or read-only transcripts', () => {
    const origin = 'http://127.0.0.1:41789';
    const toolResult = `browser: blocked private target. Allow this project origin with /browser allow ${origin}`;
    const { rerender } = render(
      <ToolLedgerCard message={{ ...message, toolResult, isError: true }} />,
    );
    expect(screen.queryByRole('button', { name: 'Allow access' })).toBeNull();

    rerender(
      <ToolLedgerCard
        message={{ ...message, toolName: 'browser_navigate', toolResult, isError: true }}
        readOnly
      />,
    );
    expect(screen.queryByRole('button', { name: 'Allow access' })).toBeNull();
  });

  it('does not advertise disclosure state when the tool has no expandable body', () => {
    render(
      <ToolLedgerCard message={{ ...message, toolInput: undefined, toolResult: undefined }} />,
    );

    // Control: the real header rendered for this tool message.
    const header = screen.getByRole('button', { name: /bash/i });
    expect(header.className).toContain('ws-tool-disclosure');
    expect(header.hasAttribute('aria-expanded')).toBe(false);
  });
});
