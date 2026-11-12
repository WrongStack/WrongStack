import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  TOOL_OVERVIEW_REGISTRY,
  ToolCallOverview,
} from '../../src/components/MessageBubble/ToolCallOverview.js';
import type { ChatMessage } from '../../src/stores/types.js';

function tool(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'tool-1',
    role: 'tool',
    content: '',
    timestamp: 1,
    toolName: 'grep',
    toolInput: { pattern: 'ToolLedgerCard', path: 'packages/webui' },
    toolResult: 'packages/webui/src/components/MessageBubble/ToolLedgerCard.tsx:1',
    ...overrides,
  };
}

describe('<ToolCallOverview />', () => {
  it('covers the complete static built-in catalog', () => {
    expect(Object.keys(TOOL_OVERVIEW_REGISTRY)).toHaveLength(69);
    expect(
      render(
        <ToolCallOverview message={tool({ toolName: 'browser_click' })} />,
      ).container.querySelector('[data-tool-overview="browser"]'),
    ).toBeTruthy();
  });

  it('renders a search-specific summary and bounded output metrics', () => {
    const { container } = render(<ToolCallOverview message={tool()} />);
    expect(container.querySelector('[data-tool-overview="filesystem"]')).toBeTruthy();
    expect(container.querySelector('[data-tool-widget="filesystem"]')).toBeTruthy();
    expect(screen.getByText('File discovery')).toBeTruthy();
    expect(screen.getByText('ToolLedgerCard')).toBeTruthy();
    expect(screen.getAllByText(/1 line/)).toHaveLength(2);
    expect(screen.getByLabelText('Result 1 line')).toBeTruthy();
  });

  it('does not expose a secret-valued field in a special widget', () => {
    render(
      <ToolCallOverview
        message={tool({ toolName: 'fetch', toolInput: { apiToken: 'do-not-show' } })}
      />,
    );
    expect(screen.queryByText('do-not-show')).toBeNull();
  });

  it.each([
    ['audit', { manager: 'pnpm' }, 'packages'],
    ['security-ast-scan', { path: 'packages/webui' }, 'security'],
    ['language', { action: 'test', language: 'typescript' }, 'language'],
    ['logs', { service: 'webui', tail: 40 }, 'observability'],
    ['tool_search', { query: 'browser' }, 'catalog'],
  ])('routes %s to its specialized overview', (toolName, toolInput, expectedKind) => {
    const { container } = render(
      <ToolCallOverview message={tool({ toolName, toolInput, toolResult: 'ok' })} />,
    );
    expect(container.querySelector(`[data-tool-overview="${expectedKind}"]`)).toBeTruthy();
  });

  it('extracts explicit verification and web result signals without showing raw output', () => {
    const { rerender } = render(
      <ToolCallOverview
        message={tool({ toolName: 'test', toolResult: '2 errors\n1 warning\nfull private output' })}
      />,
    );
    expect(screen.getByLabelText('Errors 2')).toBeTruthy();
    expect(screen.getByLabelText('Warnings 1')).toBeTruthy();
    expect(screen.queryByText('full private output')).toBeNull();

    rerender(
      <ToolCallOverview message={tool({ toolName: 'fetch', toolResult: 'HTTP 201\ncreated' })} />,
    );
    expect(screen.getByLabelText('HTTP 201')).toBeTruthy();
  });

  it('uses server output metrics instead of recounting a bounded preview', () => {
    render(
      <ToolCallOverview
        message={tool({
          toolName: 'grep',
          toolResult: 'preview line only',
          toolOutputBytes: 4096,
          toolOutputLines: 90,
        })}
      />,
    );
    expect(screen.getByText('90 lines · 4.0 KiB')).toBeTruthy();
    expect(screen.getByLabelText('Result 90 lines')).toBeTruthy();
  });
});
