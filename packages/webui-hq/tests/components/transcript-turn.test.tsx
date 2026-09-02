/**
 * Transcript rendering — the densest surface in HQ, and the one where a
 * regression is least obvious. These pin WHICH shape each entry becomes, not
 * how it is styled: role dispatch, the tool-card default-collapsed rule, the
 * errored-tool-call special case, and the empty-system-line drop.
 *
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { HqTranscriptEntry } from '@wrongstack/core/hq';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { TranscriptTurn } from '../../src/components/hq/transcript/turn.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function entry(overrides: Partial<HqTranscriptEntry> = {}): HqTranscriptEntry {
  return {
    ts: '2026-07-14T12:00:00.000Z',
    role: 'assistant',
    text: 'hello',
    ...overrides,
  };
}

function render(node: HqTranscriptEntry, running?: boolean): HTMLDivElement {
  container = document.createElement('div');
  document.body.append(container);
  const created = createRoot(container);
  root = created;
  act(() => created.render(<TranscriptTurn entry={node} running={running} />));
  return container;
}

function role(host: HTMLDivElement): string | null {
  return host.querySelector('[data-testid="transcript-turn"]')?.getAttribute('data-role') ?? null;
}

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('role dispatch', () => {
  it('renders a user bubble', () => {
    const host = render(entry({ role: 'user', text: 'do the thing' }));
    expect(role(host)).toBe('user');
    expect(host.textContent).toContain('do the thing');
  });

  it('renders an assistant bubble as markdown', () => {
    const host = render(entry({ role: 'assistant', text: '# Heading' }));
    expect(role(host)).toBe('assistant');
    expect(host.querySelector('[data-testid="markdown"] h1')?.textContent).toBe('Heading');
  });

  it('renders thinking collapsed, showing only the first line', () => {
    const host = render(entry({ role: 'thinking', text: 'first line\nsecond line' }));
    expect(role(host)).toBe('thinking');
    expect(host.querySelector('[data-testid="thinking-peek"]')?.textContent).toBe('first line');
    expect(host.querySelector('[data-testid="thinking-body"]')).toBeNull();
  });

  it('expands thinking on click', () => {
    const host = render(entry({ role: 'thinking', text: 'reasoning' }));
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="thinking-head"]')?.click());
    expect(host.querySelector('[data-testid="thinking-body"]')).not.toBeNull();
  });

  it('renders an error bubble', () => {
    const host = render(entry({ role: 'error', text: 'boom' }));
    expect(role(host)).toBe('error');
    expect(host.textContent).toContain('boom');
  });

  it('renders a system line', () => {
    const host = render(entry({ role: 'system', text: 'session resumed' }));
    expect(role(host)).toBe('system');
  });

  it('drops an empty system line rather than rendering a blank row', () => {
    const host = render(entry({ role: 'system', text: '   ' }));
    expect(host.innerHTML).toBe('');
  });
});

describe('tool cards', () => {
  const toolEntry = entry({
    role: 'tool',
    tool: 'Read',
    toolInput: '{"file_path":"/tmp/a.ts"}',
    text: '1→const a = 1;',
    durationMs: 820,
  });

  it('is collapsed by default — an expanded transcript of forty calls is unreadable', () => {
    const host = render(toolEntry);
    expect(role(host)).toBe('tool');
    expect(host.querySelector('[data-testid="tool-body"]')).toBeNull();
  });

  it('shows the tool name and duration in the header', () => {
    const host = render(toolEntry);
    expect(host.querySelector('[data-testid="tool-name"]')?.textContent).toBe('Read');
    expect(host.querySelector('[data-testid="tool-duration"]')?.textContent).toBe('820ms');
  });

  it('expands on click and renders the result', () => {
    const host = render(toolEntry);
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="tool-head"]')?.click());
    expect(host.querySelector('[data-testid="tool-body"]')).not.toBeNull();
    expect(host.textContent).toContain('const a = 1;');
  });

  it('marks a numbered read as no-wrap so the gutter stays aligned', () => {
    const host = render(toolEntry);
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="tool-head"]')?.click());
    expect(
      host.querySelector('[data-testid="tool-result-pre"]')?.getAttribute('data-wrap'),
    ).toBe('false');
  });

  it('shows ok / error status', () => {
    const ok = render(toolEntry);
    expect(ok.querySelector('[data-testid="tool-status-ok"]')).not.toBeNull();
    act(() => root?.unmount());
    container?.remove();

    const failed = render(entry({ role: 'tool', tool: 'Bash', text: 'nope', isError: true }));
    expect(failed.querySelector('[data-testid="tool-status-error"]')).not.toBeNull();
    expect(
      failed.querySelector('[data-testid="transcript-turn"]')?.getAttribute('data-error'),
    ).toBe('true');
  });

  it('pulses only while the caller says the call is running', () => {
    const host = render(entry({ role: 'tool', tool: 'Bash', text: '' }), true);
    expect(host.querySelector('[data-testid="tool-running"]')).not.toBeNull();
  });

  it('renders a failed tool call as a tool card, not a bare error bubble', () => {
    // The server merges a failure into the args entry with role 'error', but
    // it still carries the tool name and input.
    const host = render(
      entry({ role: 'error', tool: 'Bash', toolInput: '{"command":"ls"}', text: 'permission denied' }),
    );
    expect(role(host)).toBe('tool');
    expect(host.querySelector('[data-testid="tool-name"]')?.textContent).toBe('Bash');
  });

  it('renders a bash exit code', () => {
    const host = render(
      entry({ role: 'tool', tool: 'Bash', toolInput: '{"command":"ls"}', text: 'out\nexit 2' }),
    );
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="tool-head"]')?.click());
    expect(host.querySelector('[data-testid="tool-result-exit"]')?.textContent).toContain(
      'exit code 2',
    );
  });

  it('says so when a call produced no output at all', () => {
    const host = render(entry({ role: 'tool', tool: 'Noop', text: '' }));
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="tool-head"]')?.click());
    expect(host.textContent).toContain('(no output)');
  });
});
