import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePasteDrop } from '../../src/components/ChatInput/use-paste-drop.js';

// Mock autoFenceCode so we can control when code-fencing triggers
vi.mock('../../src/components/ChatInput/code-detect.js', () => ({
  autoFenceCode: vi.fn(),
}));

function mockTextarea(selectionStart = 0, selectionEnd = 0): HTMLTextAreaElement {
  const ta = {
    selectionStart,
    selectionEnd,
    focus: vi.fn(),
    setSelectionRange: vi.fn(),
    style: { height: '' },
    scrollHeight: 100,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return ta as unknown as HTMLTextAreaElement;
}

function makeHookOptions(overrides: { input?: string; selectionStart?: number } = {}) {
  const textarea = mockTextarea(overrides.selectionStart ?? 0, overrides.selectionStart ?? 0);
  const textareaRef = { current: textarea };
  const setInput = vi.fn();
  const setAtMention = vi.fn();

  return {
    textarea,
    textareaRef,
    setInput,
    setAtMention,
    options: {
      input: overrides.input ?? '',
      textareaRef: textareaRef as React.RefObject<HTMLTextAreaElement | null>,
      setInput,
      setAtMention,
    },
  };
}

describe('usePasteDrop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('returns null pasteHint and false draggingOver initially', () => {
      const { textareaRef, setInput, setAtMention } = makeHookOptions();
      const { result } = renderHook(() =>
        usePasteDrop({ input: '', textareaRef, setInput, setAtMention }),
      );

      expect(result.current.pasteHint).toBeNull();
      expect(result.current.draggingOver).toBe(false);
      expect(result.current.pendingImageRef).toBeDefined();
    });
  });

  describe('drag/drop handlers', () => {
    it('onDragEnter sets draggingOver true for file drags', () => {
      const { options } = makeHookOptions();
      const { result } = renderHook(() => usePasteDrop(options));

      const event = {
        dataTransfer: { types: ['Files'] },
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent<HTMLFormElement>;

      act(() => result.current.onDragEnter(event));

      expect(result.current.draggingOver).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it('onDragEnter ignores non-file drags', () => {
      const { options } = makeHookOptions();
      const { result } = renderHook(() => usePasteDrop(options));

      const event = {
        dataTransfer: { types: ['text/plain'] },
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent<HTMLFormElement>;

      act(() => result.current.onDragEnter(event));

      expect(result.current.draggingOver).toBe(false);
    });

    it('onDragOver prevents default for file drags and sets dropEffect', () => {
      const { options } = makeHookOptions();
      const { result } = renderHook(() => usePasteDrop(options));

      const event = {
        dataTransfer: { types: ['Files'], dropEffect: '' },
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent<HTMLFormElement>;

      act(() => result.current.onDragOver(event));

      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.dataTransfer.dropEffect).toBe('copy');
    });

    it('onDragLeave clears draggingOver when cursor leaves form', () => {
      const { options } = makeHookOptions();
      const { result } = renderHook(() => usePasteDrop(options));

      act(() => result.current.onDragEnter({
        dataTransfer: { types: ['Files'] },
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent<HTMLFormElement>));

      expect(result.current.draggingOver).toBe(true);

      act(() => result.current.onDragLeave({
        currentTarget: { contains: () => false },
        relatedTarget: null,
      } as unknown as React.DragEvent<HTMLFormElement>));

      expect(result.current.draggingOver).toBe(false);
    });

    it('onDrop inserts @filename tokens and opens atMention for last file', () => {
      const { options, setInput, setAtMention, textarea } = makeHookOptions({ input: 'hello', selectionStart: 5 });

      const { result } = renderHook(() => usePasteDrop(options));

      const file = { name: 'test.ts' } as File;
      const event = {
        dataTransfer: { files: [file] },
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent<HTMLFormElement>;

      act(() => result.current.onDrop(event));

      expect(event.preventDefault).toHaveBeenCalled();
      expect(setInput).toHaveBeenCalledTimes(1);
      const inserted = setInput.mock.calls[0][0] as string;
      expect(inserted).toContain('@test.ts');
      // setAtMention called via requestAnimationFrame — verify queued
      expect(setAtMention).not.toHaveBeenCalled();
    });

    it('onDrop with an image file attaches it instead of inserting an @mention', async () => {
      const { options, setInput } = makeHookOptions({ input: 'hi', selectionStart: 2 });
      const { result } = renderHook(() => usePasteDrop(options));

      const imageFile = new File(['fake-bytes'], 'shot.png', { type: 'image/png' });
      const event = {
        dataTransfer: { files: [imageFile] },
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent<HTMLFormElement>;

      act(() => {
        result.current.onDrop(event);
      });

      // No @mention insertion for a pure-image drop (synchronous decision).
      expect(setInput).not.toHaveBeenCalled();
      // FileReader resolves asynchronously — poll until the data URL lands.
      await waitFor(() => {
        expect(typeof result.current.pendingImage).toBe('string');
        expect(result.current.pendingImage).toMatch(/^data:image\/png/);
      });
    });

    it('clearPendingImage resets the pending image', async () => {
      const { options } = makeHookOptions();
      const { result } = renderHook(() => usePasteDrop(options));
      const imageFile = new File(['x'], 'a.png', { type: 'image/png' });

      act(() => {
        result.current.onDrop({
          dataTransfer: { files: [imageFile] },
          preventDefault: vi.fn(),
        } as unknown as React.DragEvent<HTMLFormElement>);
      });
      await waitFor(() => expect(result.current.pendingImage).toBeTruthy());

      act(() => result.current.clearPendingImage());
      expect(result.current.pendingImage).toBeNull();
    });

    it('onDrop with empty files clears draggingOver and returns', () => {
      const { options } = makeHookOptions();
      const { result } = renderHook(() => usePasteDrop(options));

      const event = {
        dataTransfer: { files: [] },
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent<HTMLFormElement>;

      act(() => result.current.onDrop(event));

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(result.current.draggingOver).toBe(false);
    });
  });

  describe('onTextPaste', () => {
    it('ignores empty paste text', () => {
      const { options, setInput } = makeHookOptions();
      const { result } = renderHook(() => usePasteDrop(options));

      const event = {
        clipboardData: { getData: () => '' },
        preventDefault: vi.fn(),
      } as unknown as React.ClipboardEvent<HTMLTextAreaElement>;

      act(() => result.current.onTextPaste(event));

      expect(setInput).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('auto-fences code paste and sets pasteHint with undo', async () => {
      const { autoFenceCode } = await import('../../src/components/ChatInput/code-detect.js');
      vi.mocked(autoFenceCode).mockReturnValue({
        lang: 'typescript',
        fenced: '```typescript\nconst x = 1;\n```',
      });

      const { options, setInput, textarea } = makeHookOptions({ input: 'before ', selectionStart: 7 });
      const { result } = renderHook(() => usePasteDrop(options));

      const event = {
        clipboardData: { getData: () => 'const x = 1;' },
        preventDefault: vi.fn(),
      } as unknown as React.ClipboardEvent<HTMLTextAreaElement>;

      act(() => result.current.onTextPaste(event));

      expect(event.preventDefault).toHaveBeenCalled();
      expect(setInput).toHaveBeenCalledTimes(1);
      const inserted = setInput.mock.calls[0][0] as string;
      expect(inserted).toContain('```typescript');
      expect(result.current.pasteHint).not.toBeNull();
      expect(result.current.pasteHint?.lang).toBe('typescript');
      expect(result.current.pasteHint?.undoFence).toBeDefined();
    });

    it('shows hint for large non-code paste (>800 chars)', async () => {
      const { autoFenceCode } = await import('../../src/components/ChatInput/code-detect.js');
      vi.mocked(autoFenceCode).mockReturnValue(null);

      const largeText = 'x'.repeat(900);
      const { options } = makeHookOptions();
      const { result } = renderHook(() => usePasteDrop(options));

      const event = {
        clipboardData: { getData: () => largeText },
        preventDefault: vi.fn(),
      } as unknown as React.ClipboardEvent<HTMLTextAreaElement>;

      act(() => result.current.onTextPaste(event));

      expect(result.current.pasteHint).not.toBeNull();
      expect(result.current.pasteHint?.chars).toBe(900);
      expect(result.current.pasteHint?.lang).toBeUndefined();
    });

    it('does nothing for small non-code paste', async () => {
      const { autoFenceCode } = await import('../../src/components/ChatInput/code-detect.js');
      vi.mocked(autoFenceCode).mockReturnValue(null);

      const { options, setInput } = makeHookOptions();
      const { result } = renderHook(() => usePasteDrop(options));

      const event = {
        clipboardData: { getData: () => 'short' },
        preventDefault: vi.fn(),
      } as unknown as React.ClipboardEvent<HTMLTextAreaElement>;

      act(() => result.current.onTextPaste(event));

      expect(setInput).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(result.current.pasteHint).toBeNull();
    });
  });

  describe('setPasteHint', () => {
    it('exposes setPasteHint for external dismissal', () => {
      const { options } = makeHookOptions();
      const { result } = renderHook(() => usePasteDrop(options));

      expect(result.current.setPasteHint).toBeDefined();
      expect(typeof result.current.setPasteHint).toBe('function');
    });
  });
});
