import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePasteDrop } from '../../src/components/ChatInput/use-paste-drop.js';
import { useFileReferenceStore } from '../../src/stores/file-reference-store.js';
import { useUIStore } from '../../src/stores/ui-store.js';

// Mock autoFenceCode so we can control when code-fencing triggers
vi.mock('../../src/components/ChatInput/code-detect.js', () => ({
  autoFenceCode: vi.fn(),
}));

// Mock the image pipeline — jsdom has no real image decoding/canvas, so
// processImageFile is replaced with a deterministic fake. Every export the
// hook consumes must be present in the factory (missing ones throw at access).
vi.mock('../../src/components/ChatInput/image-attachments.js', () => {
  class ImageAttachmentError extends Error {
    constructor(
      message: string,
      readonly reason: string,
    ) {
      super(message);
    }
  }
  let seq = 0;
  return {
    ImageAttachmentError,
    MAX_ATTACHED_IMAGES: 8,
    processImageFile: vi.fn(async (file: File) => {
      seq += 1;
      return {
        id: `img_${seq}`,
        dataUrl: 'data:image/png;base64,AAAA',
        mediaType: file.type || 'image/png',
        bytes: 4,
        name: file.name,
      };
    }),
  };
});

// Mock toast so attachment errors don't need a mounted Toaster.
vi.mock('../../src/components/Toaster.js', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
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
  return ta as never as HTMLTextAreaElement;
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
      errorText: {
        tooManyImages: (max: number) => `too many (${max})`,
        imageProcessFailed: (name: string) => `failed ${name}`,
        imageTooLarge: (name: string) => `too large ${name}`,
      },
    },
  };
}

describe('usePasteDrop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFileReferenceStore.setState({ refs: [] });
    useUIStore.setState({ draftImages: [] });
  });

  describe('initial state', () => {
    it('returns null pasteHint and false draggingOver initially', () => {
      const { options } = makeHookOptions();
      const { result } = renderHook(() => usePasteDrop(options));

      expect(result.current.pasteHint).toBeNull();
      expect(result.current.draggingOver).toBe(false);
      expect(result.current.pendingImagesRef.current).toEqual([]);
      expect(result.current.pendingImages).toEqual([]);
    });
  });

  describe('drag/drop handlers', () => {
    it('onDragEnter sets draggingOver true for file drags', () => {
      const { options } = makeHookOptions();
      const { result } = renderHook(() => usePasteDrop(options));

      const event = {
        dataTransfer: { types: ['Files'] },
        preventDefault: vi.fn(),
      } as never as React.DragEvent<HTMLFormElement>;

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
      } as never as React.DragEvent<HTMLFormElement>;

      act(() => result.current.onDragEnter(event));

      expect(result.current.draggingOver).toBe(false);
    });

    it('onDragOver prevents default for file drags and sets dropEffect', () => {
      const { options } = makeHookOptions();
      const { result } = renderHook(() => usePasteDrop(options));

      const event = {
        dataTransfer: { types: ['Files'], dropEffect: '' },
        preventDefault: vi.fn(),
      } as never as React.DragEvent<HTMLFormElement>;

      act(() => result.current.onDragOver(event));

      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.dataTransfer.dropEffect).toBe('copy');
    });

    it('onDragLeave clears draggingOver when cursor leaves form', () => {
      const { options } = makeHookOptions();
      const { result } = renderHook(() => usePasteDrop(options));

      act(() =>
        result.current.onDragEnter({
          dataTransfer: { types: ['Files'] },
          preventDefault: vi.fn(),
        } as never as React.DragEvent<HTMLFormElement>),
      );

      expect(result.current.draggingOver).toBe(true);

      act(() =>
        result.current.onDragLeave({
          currentTarget: { contains: () => false },
          relatedTarget: null,
        } as never as React.DragEvent<HTMLFormElement>),
      );

      expect(result.current.draggingOver).toBe(false);
    });

    it('onDrop shows a toast for non-image files (browser strips paths)', () => {
      const { options, setInput } = makeHookOptions({ input: 'hello', selectionStart: 5 });

      const { result } = renderHook(() => usePasteDrop(options));

      const file = { name: 'test.ts' } as File;
      const event = {
        dataTransfer: { files: [file] },
        preventDefault: vi.fn(),
      } as never as React.DragEvent<HTMLFormElement>;

      act(() => result.current.onDrop(event));

      expect(event.preventDefault).toHaveBeenCalled();
      // Non-image drops no longer create ref chips (browser strips the path).
      expect(setInput).not.toHaveBeenCalled();
      const refs = useFileReferenceStore.getState().refs;
      expect(refs).toHaveLength(0);
    });

    it('onDrop with an image file attaches it instead of inserting an @mention', async () => {
      const { options, setInput } = makeHookOptions({ input: 'hi', selectionStart: 2 });
      const { result } = renderHook(() => usePasteDrop(options));

      const imageFile = new File(['fake-bytes'], 'shot.png', { type: 'image/png' });
      const event = {
        dataTransfer: { files: [imageFile] },
        preventDefault: vi.fn(),
      } as never as React.DragEvent<HTMLFormElement>;

      act(() => {
        result.current.onDrop(event);
      });

      // No @mention insertion for a pure-image drop (synchronous decision).
      expect(setInput).not.toHaveBeenCalled();
      // Image processing resolves asynchronously — poll until the chip lands.
      await waitFor(() => {
        expect(result.current.pendingImages).toHaveLength(1);
        expect(result.current.pendingImages[0]?.dataUrl).toMatch(/^data:image\/png/);
        expect(result.current.pendingImages[0]?.name).toBe('shot.png');
      });
    });

    it('onDrop attaches multiple images in order', async () => {
      const { options } = makeHookOptions();
      const { result } = renderHook(() => usePasteDrop(options));
      const files = [
        new File(['a'], 'a.png', { type: 'image/png' }),
        new File(['b'], 'b.jpg', { type: 'image/jpeg' }),
      ];

      act(() => {
        result.current.onDrop({
          dataTransfer: { files },
          preventDefault: vi.fn(),
        } as never as React.DragEvent<HTMLFormElement>);
      });

      await waitFor(() => {
        expect(result.current.pendingImages.map((i) => i.name)).toEqual(['a.png', 'b.jpg']);
      });
    });

    it('removeImage removes one chip; clearPendingImages resets all', async () => {
      const { options } = makeHookOptions();
      const { result } = renderHook(() => usePasteDrop(options));
      const files = [
        new File(['a'], 'a.png', { type: 'image/png' }),
        new File(['b'], 'b.png', { type: 'image/png' }),
      ];

      await act(async () => {
        await result.current.addImageFiles(files);
      });
      expect(result.current.pendingImages).toHaveLength(2);

      const firstId = result.current.pendingImages[0]?.id as string;
      act(() => result.current.removeImage(firstId));
      expect(result.current.pendingImages).toHaveLength(1);
      expect(result.current.pendingImages[0]?.name).toBe('b.png');

      act(() => result.current.clearPendingImages());
      expect(result.current.pendingImages).toEqual([]);
      expect(result.current.pendingImagesRef.current).toEqual([]);
    });

    it('onDrop with empty files clears draggingOver and returns', () => {
      const { options } = makeHookOptions();
      const { result } = renderHook(() => usePasteDrop(options));

      const event = {
        dataTransfer: { files: [] },
        preventDefault: vi.fn(),
      } as never as React.DragEvent<HTMLFormElement>;

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
      } as never as React.ClipboardEvent<HTMLTextAreaElement>;

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

      const { options, setInput, _textarea } = makeHookOptions({
        input: 'before ',
        selectionStart: 7,
      });
      const { result } = renderHook(() => usePasteDrop(options));

      const event = {
        clipboardData: { getData: () => 'const x = 1;' },
        preventDefault: vi.fn(),
      } as never as React.ClipboardEvent<HTMLTextAreaElement>;

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
      } as never as React.ClipboardEvent<HTMLTextAreaElement>;

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
      } as never as React.ClipboardEvent<HTMLTextAreaElement>;

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

// ── Coverage completion pass (2026-07-29) ───────────────────────────────────
// The blocks above use a fully stubbed textarea whose addEventListener is a
// spy, so the native `paste` interception and the undo-fence callback never
// ran. These use a real element and drive the real listener.

import { autoFenceCode } from '../../src/components/ChatInput/code-detect.js';
import { processImageFile } from '../../src/components/ChatInput/image-attachments.js';
import { toast } from '../../src/components/Toaster.js';

function realTextarea(): HTMLTextAreaElement {
  const ta = document.createElement('textarea');
  document.body.appendChild(ta);
  return ta;
}

function liveOptions(input = '') {
  const textarea = realTextarea();
  const textareaRef = { current: textarea } as React.RefObject<HTMLTextAreaElement | null>;
  const setInput = vi.fn();
  return {
    textarea,
    setInput,
    options: {
      input,
      textareaRef,
      setInput,
      errorText: {
        tooManyImages: (max: number) => `too many (${max})`,
        imageProcessFailed: (name: string) => `failed ${name}`,
        imageTooLarge: (name: string) => `too large ${name}`,
      },
    },
  };
}

function imageFile(name = 'shot.png', type = 'image/png'): File {
  return new File(['x'], name, { type });
}

/** A ClipboardEvent carrying the given items. */
function pasteEventWith(items: Array<{ type: string; file: File | null }>): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      items: items.map((i) => ({ type: i.type, getAsFile: () => i.file })),
    },
  });
  return event;
}

describe('usePasteDrop — native clipboard interception', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    useUIStore.setState({ draftImages: [] });
  });

  it('attaches a pasted image and swallows the event', async () => {
    const { textarea, options } = liveOptions();
    const { result } = renderHook(() => usePasteDrop(options));

    const event = pasteEventWith([{ type: 'image/png', file: imageFile() }]);
    await act(async () => {
      textarea.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(result.current.pendingImages).toHaveLength(1));
  });

  it('ignores a paste with no clipboardData', async () => {
    const { textarea, options } = liveOptions();
    const { result } = renderHook(() => usePasteDrop(options));

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: null });
    await act(async () => {
      textarea.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(result.current.pendingImages).toHaveLength(0);
  });

  it('ignores a text-only paste', async () => {
    const { textarea, options } = liveOptions();
    const { result } = renderHook(() => usePasteDrop(options));

    const event = pasteEventWith([{ type: 'text/plain', file: null }]);
    await act(async () => {
      textarea.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(result.current.pendingImages).toHaveLength(0);
  });

  it('skips an image item whose blob is unavailable', async () => {
    const { textarea, options } = liveOptions();
    const { result } = renderHook(() => usePasteDrop(options));

    const event = pasteEventWith([{ type: 'image/png', file: null }]);
    await act(async () => {
      textarea.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(result.current.pendingImages).toHaveLength(0);
  });

  it('attaches every image in a multi-image paste', async () => {
    const { textarea, options } = liveOptions();
    const { result } = renderHook(() => usePasteDrop(options));

    await act(async () => {
      textarea.dispatchEvent(
        pasteEventWith([
          { type: 'image/png', file: imageFile('a.png') },
          { type: 'image/jpeg', file: imageFile('b.jpg', 'image/jpeg') },
        ]),
      );
    });

    await waitFor(() => expect(result.current.pendingImages).toHaveLength(2));
  });

  it('detaches the listener on unmount', async () => {
    const { textarea, options } = liveOptions();
    const { result, unmount } = renderHook(() => usePasteDrop(options));
    unmount();

    await act(async () => {
      textarea.dispatchEvent(pasteEventWith([{ type: 'image/png', file: imageFile() }]));
    });
    expect(result.current.pendingImages).toHaveLength(0);
  });

  it('is inert when the textarea ref is not attached', () => {
    const setInput = vi.fn();
    const options = {
      input: '',
      textareaRef: { current: null } as React.RefObject<HTMLTextAreaElement | null>,
      setInput,
      errorText: {
        tooManyImages: (max: number) => `too many (${max})`,
        imageProcessFailed: (name: string) => `failed ${name}`,
        imageTooLarge: (name: string) => `too large ${name}`,
      },
    };
    expect(() => renderHook(() => usePasteDrop(options))).not.toThrow();
  });
});

describe('usePasteDrop — attachment cap and failures', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    useUIStore.setState({ draftImages: [] });
  });

  it('stops at the per-message cap and reports it once', async () => {
    const { options } = liveOptions();
    const { result } = renderHook(() => usePasteDrop(options));

    await act(async () => {
      await result.current.addImageFiles(
        Array.from({ length: 10 }, (_, i) => imageFile(`f${i}.png`)),
      );
    });

    expect(result.current.pendingImages).toHaveLength(8);
    expect(toast.error).toHaveBeenCalledWith('too many (8)');
    // It returns on the first over-cap file rather than toasting per file.
    expect((toast.error as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('reports an over-large image with the dedicated message', async () => {
    const { ImageAttachmentError } = await import(
      '../../src/components/ChatInput/image-attachments.js'
    );
    (processImageFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new (ImageAttachmentError as never as new (m: string, r: string) => Error)(
        'nope',
        'too_large',
      ),
    );
    const { options } = liveOptions();
    const { result } = renderHook(() => usePasteDrop(options));

    await act(async () => {
      await result.current.addImageFiles([imageFile('huge.png')]);
    });

    expect(toast.error).toHaveBeenCalledWith('too large huge.png');
  });

  it('reports any other failure as a decode problem', async () => {
    (processImageFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const { options } = liveOptions();
    const { result } = renderHook(() => usePasteDrop(options));

    await act(async () => {
      await result.current.addImageFiles([imageFile('broken.png')]);
    });

    expect(toast.error).toHaveBeenCalledWith('failed broken.png');
  });

  it('substitutes a placeholder name for an unnamed file', async () => {
    (processImageFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const { options } = liveOptions();
    const { result } = renderHook(() => usePasteDrop(options));

    await act(async () => {
      await result.current.addImageFiles([new File(['x'], '', { type: 'image/png' })]);
    });

    expect(toast.error).toHaveBeenCalledWith('failed image');
  });

  it('keeps processing later files after one fails', async () => {
    (processImageFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const { options } = liveOptions();
    const { result } = renderHook(() => usePasteDrop(options));

    await act(async () => {
      await result.current.addImageFiles([imageFile('bad.png'), imageFile('good.png')]);
    });

    expect(result.current.pendingImages).toHaveLength(1);
  });

  it('removeImage drops just that attachment', async () => {
    const { options } = liveOptions();
    const { result } = renderHook(() => usePasteDrop(options));

    await act(async () => {
      await result.current.addImageFiles([imageFile('a.png'), imageFile('b.png')]);
    });
    const first = result.current.pendingImages[0]!.id;

    act(() => result.current.removeImage(first));
    expect(result.current.pendingImages).toHaveLength(1);
    expect(result.current.pendingImagesRef.current).toHaveLength(1);
  });

  it('removeImage is a no-op for an unknown id', async () => {
    const { options } = liveOptions();
    const { result } = renderHook(() => usePasteDrop(options));
    await act(async () => {
      await result.current.addImageFiles([imageFile('a.png')]);
    });
    act(() => result.current.removeImage('nope'));
    expect(result.current.pendingImages).toHaveLength(1);
  });

  it('clearPendingImages empties both the state and the submit-time ref', async () => {
    const { options } = liveOptions();
    const { result } = renderHook(() => usePasteDrop(options));
    await act(async () => {
      await result.current.addImageFiles([imageFile('a.png')]);
    });

    act(() => result.current.clearPendingImages());
    expect(result.current.pendingImages).toHaveLength(0);
    expect(result.current.pendingImagesRef.current).toHaveLength(0);
  });
});

describe('usePasteDrop — undo-fence', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  });

  it('restores the raw text and clears the hint', () => {
    (autoFenceCode as ReturnType<typeof vi.fn>).mockReturnValue({
      fenced: '```ts\nconst a = 1;\n```',
      lang: 'ts',
    });
    const { options, setInput } = liveOptions('');
    const { result } = renderHook(() => usePasteDrop(options));

    const event = {
      clipboardData: { getData: () => 'const a = 1;' },
      preventDefault: vi.fn(),
    } as never as React.ClipboardEvent<HTMLTextAreaElement>;

    act(() => result.current.onTextPaste(event));
    expect(result.current.pasteHint?.lang).toBe('ts');

    const undo = result.current.pasteHint?.undoFence;
    expect(undo).toBeTypeOf('function');

    act(() => undo?.());
    // The last setInput call restores the unfenced text.
    expect(setInput).toHaveBeenLastCalledWith('const a = 1;');
    expect(result.current.pasteHint).toBeNull();
  });
});
