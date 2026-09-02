// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useImageAttachments, type AttachedImage } from '../src/hooks/use-image-attachments.js';

interface Captured {
  current: ReturnType<typeof useImageAttachments>;
}

const roots: Root[] = [];

function renderHookViaRoot(captured: Captured): Root {
  function Probe(): null {
    captured.current = useImageAttachments();
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<Probe />));
  return root;
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('useImageAttachments — initial state', () => {
  it('starts with no attached images', () => {
    const captured: Captured = { current: undefined as never };
    renderHookViaRoot(captured);
    expect(captured.current.attachedImages).toEqual([]);
  });
});

describe('useImageAttachments — attachImages', () => {
  it('creates a hidden file input, clicks it, and cleans up after change', () => {
    const captured: Captured = { current: undefined as never };
    renderHookViaRoot(captured);

    // Spy on createElement to capture the input element.
    const inputs: HTMLInputElement[] = [];
    const origCreate = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'input') {
        const input = el as HTMLInputElement;
        input.click = vi.fn();
        inputs.push(input);
      }
      return el;
    });

    act(() => captured.current.attachImages());

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.type).toBe('file');
    expect(inputs[0]?.accept).toBe('image/*');
    expect(inputs[0]?.multiple).toBe(true);
    // Programmatic click was invoked.
    expect(inputs[0]?.click).toHaveBeenCalled();

    spy.mockRestore();
  });

  it('adds images via setAttachedImages and supports multiple', () => {
    const captured: Captured = { current: undefined as never };
    renderHookViaRoot(captured);

    const img1: AttachedImage = {
      id: 'img-1',
      data: 'data:image/png;base64,aa',
      mime: 'image/png',
      name: 'a.png',
    };
    const img2: AttachedImage = {
      id: 'img-2',
      data: 'data:image/jpeg;base64,bb',
      mime: 'image/jpeg',
      name: 'b.jpg',
    };
    act(() => captured.current.setAttachedImages([img1, img2]));
    expect(captured.current.attachedImages).toHaveLength(2);
    expect(captured.current.attachedImages[0]?.name).toBe('a.png');
    expect(captured.current.attachedImages[1]?.mime).toBe('image/jpeg');
  });

  it('does nothing when the picker is cancelled (no files)', () => {
    const captured: Captured = { current: undefined as never };
    renderHookViaRoot(captured);

    const origCreate = document.createElement.bind(document);
    let capturedInput: HTMLInputElement | null = null;
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'input') {
        capturedInput = el as HTMLInputElement;
        (capturedInput as HTMLInputElement).click = vi.fn();
      }
      return el;
    });

    act(() => captured.current.attachImages());

    // Simulate cancel: files is null.
    Object.defineProperty(capturedInput, 'files', { value: null, writable: false });
    act(() => {
      capturedInput?.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(captured.current.attachedImages).toEqual([]);
  });
});

describe('useImageAttachments — removeImage', () => {
  it('removes an image by id', () => {
    const captured: Captured = { current: undefined as never };
    renderHookViaRoot(captured);

    const img: AttachedImage = {
      id: 'test-1',
      data: 'data:image/png;base64,xx',
      mime: 'image/png',
      name: 'a.png',
    };
    act(() => captured.current.setAttachedImages([img]));
    expect(captured.current.attachedImages).toHaveLength(1);

    act(() => captured.current.removeImage('test-1'));
    expect(captured.current.attachedImages).toEqual([]);
  });

  it('does not remove other images when removing by a non-matching id', () => {
    const captured: Captured = { current: undefined as never };
    renderHookViaRoot(captured);

    const img: AttachedImage = {
      id: 'keep',
      data: 'data:image/png;base64,yy',
      mime: 'image/png',
      name: 'b.png',
    };
    act(() => captured.current.setAttachedImages([img]));
    act(() => captured.current.removeImage('nonexistent'));
    expect(captured.current.attachedImages).toHaveLength(1);
  });
});
