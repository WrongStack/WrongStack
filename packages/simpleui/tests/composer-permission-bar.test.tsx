// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../src/composer.js';
import type { PendingConfirm } from '../src/types.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Behavior coverage for the Composer permission bar: alertdialog semantics,
 * risk-aware autofocus (Deny for destructive tools, Allow for standard),
 * key hints for assistive tech, and focus restore to the composer once the
 * prompt resolves.
 *
 * The Y/N/A keyboard layer is a global shortcut and is covered by
 * use-global-shortcuts.test.tsx.
 */

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function composerProps(pendingConfirm: PendingConfirm | null) {
  return {
    draft: '',
    setDraft: vi.fn(),
    fileRefs: [] as string[],
    setFileRefs: vi.fn(),
    fileMention: null,
    setFileMention: vi.fn(),
    fileMatches: [] as string[],
    filePickerIndex: 0,
    setFilePickerIndex: vi.fn(),
    fileSearching: false,
    running: false,
    connection: 'open',
    session: null,
    pendingConfirm,
    notice: null,
    textareaRef: { current: null as HTMLTextAreaElement | null },
    queue: [],
    refineState: null,
    submitWith: vi.fn(),
    abort: vi.fn(),
    decideConfirm: vi.fn(),
    selectFile: vi.fn(),
    clearQueue: vi.fn(),
    removeQueued: vi.fn(),
    onRefineDecision: vi.fn(),
    onRefineRetry: vi.fn(),
    onRefineRetryFallback: vi.fn(),
    onRefineStartNow: vi.fn(),
    onRefineSendEdited: vi.fn(),
    attachedImages: [] as { id: string; data: string; mime: string; name: string }[],
    onAttachImages: vi.fn(),
    onRemoveImage: vi.fn(),
    visionSupported: false,
  };
}

type ComposerPropsStub = ReturnType<typeof composerProps>;

function mountComposer(props: ComposerPropsStub): {
  container: HTMLElement;
  rerender: (pendingConfirm: PendingConfirm | null) => void;
} {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<Composer {...props} />));
  roots.push(root);
  return {
    container,
    rerender(pendingConfirm: PendingConfirm | null) {
      props.pendingConfirm = pendingConfirm;
      act(() => root.render(<Composer {...props} />));
    },
  };
}

describe('Composer permission bar', () => {
  it('renders an alertdialog with labelled title and described input', () => {
    const props = composerProps({ id: 'c1', toolName: 'bash', input: { command: 'ls -la' } });
    const { container } = mountComposer(props);
    const bar = container.querySelector('[role="alertdialog"]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('aria-labelledby')).toBe('permission-confirm-title');
    expect(bar?.getAttribute('aria-describedby')).toBe('permission-confirm-input');
    expect(document.getElementById('permission-confirm-title')?.textContent).toContain('bash');
    expect(document.getElementById('permission-confirm-input')?.textContent).toContain('ls -la');
  });

  it('focuses Allow for a standard-tier prompt', () => {
    const props = composerProps({ id: 'c1', toolName: 'exec', input: 'npm test' });
    mountComposer(props);
    expect(document.activeElement?.textContent).toBe('Allow');
  });

  it('treats an absent tier as standard', () => {
    const props = composerProps({ id: 'c1', toolName: 'exec', input: 'npm test' });
    mountComposer(props);
    expect(document.activeElement?.textContent).toBe('Allow');
  });

  it('focuses Deny for a destructive-tier prompt', () => {
    const props = composerProps({
      id: 'c1',
      toolName: 'bash',
      input: 'rm -rf build',
      riskTier: 'destructive',
    });
    mountComposer(props);
    expect(document.activeElement?.textContent).toBe('Deny');
  });

  it('fails safe to Deny focus for unknown non-standard tiers', () => {
    const props = composerProps({
      id: 'c1',
      toolName: 'future-tool',
      input: '???',
      riskTier: 'exotic',
    });
    mountComposer(props);
    expect(document.activeElement?.textContent).toBe('Deny');
  });

  it('exposes Y/N/A key hints to assistive tech', () => {
    const props = composerProps({ id: 'c1', toolName: 'bash', input: 'ls' });
    const { container } = mountComposer(props);
    const shortcuts = [...container.querySelectorAll('[aria-keyshortcuts]')].map((button) =>
      button.getAttribute('aria-keyshortcuts'),
    );
    expect(shortcuts).toEqual(['n', 'a', 'y']);
  });

  it('returns focus to the composer textarea once the prompt resolves', () => {
    const props = composerProps({ id: 'c1', toolName: 'bash', input: 'ls' });
    const { rerender } = mountComposer(props);
    expect(document.activeElement?.textContent).toBe('Allow');
    rerender(null);
    expect(document.activeElement).toBe(props.textareaRef.current);
  });
});
