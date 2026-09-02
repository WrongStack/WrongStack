import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { InputBuilder } from '@wrongstack/core/agent';
import { Text } from '../src/ink.js';
import { usePasteHandling, type UsePasteHandlingOptions } from '../src/hooks/use-paste-handling.js';
import { MAX_PASTE_CHARS } from '../src/input-validation.js';
import { TokenPreviewStore } from '../src/token-previews.js';
import * as clipboardModule from '../src/clipboard.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeBuilder(overrides?: Partial<InputBuilder>): InputBuilder {
  return {
    wouldCollapse: vi.fn(() => false),
    registerPaste: vi.fn(async (full: string) => `[pasted:${full.length}]`),
    registerImage: vi.fn(async (_base64: string, _mediaType: string) => '[image]'),
    ...overrides,
  } as unknown as InputBuilder;
}

interface HarnessRefs {
  builderRef: React.MutableRefObject<InputBuilder | null>;
  dispatch: Mock;
  draftRef: React.MutableRefObject<{ buffer: string; cursor: number }>;
  setDraft: Mock;
  tokenPreviewsRef: React.MutableRefObject<TokenPreviewStore>;
  result: { current: ReturnType<typeof usePasteHandling> | null };
}

function buildHarness(): HarnessRefs {
  const dispatch = vi.fn();
  const setDraft = vi.fn();
  return {
    builderRef: { current: null },
    dispatch,
    draftRef: { current: { buffer: '', cursor: 0 } },
    setDraft,
    tokenPreviewsRef: { current: new TokenPreviewStore() },
    result: { current: null },
  };
}

function Harness({ refs }: { refs: HarnessRefs }): React.ReactElement {
  const opts: UsePasteHandlingOptions = {
    builderRef: refs.builderRef,
    dispatch: refs.dispatch,
    draftRef: refs.draftRef,
    setDraft: refs.setDraft,
    tokenPreviewsRef: refs.tokenPreviewsRef,
  };
  refs.result.current = usePasteHandling(opts);
  return React.createElement(Text, null, 'paste-harness');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ── commitPaste ────────────────────────────────────────────────────────

describe('commitPaste', () => {
  it('does nothing when builder is null', async () => {
    const refs = buildHarness();
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.commitPaste('hello');
    expect(refs.setDraft).not.toHaveBeenCalled();
  });

  it('does nothing when full is empty string', async () => {
    const refs = buildHarness();
    refs.builderRef.current = makeBuilder();
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.commitPaste('');
    expect(refs.setDraft).not.toHaveBeenCalled();
  });

  it('inserts inline for slash command content', async () => {
    const refs = buildHarness();
    refs.builderRef.current = makeBuilder({ wouldCollapse: vi.fn(() => false) });
    refs.draftRef.current = { buffer: '/fix', cursor: 4 };
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.commitPaste('the error');
    expect(refs.setDraft).toHaveBeenCalledWith('/fixthe error', 13);
  });

  it('collapses multi-line content via builder.registerPaste', async () => {
    const builder = makeBuilder();
    builder.registerPaste = vi.fn(async () => '[pasted:N]');
    const refs = buildHarness();
    refs.builderRef.current = builder;
    refs.draftRef.current = { buffer: 'abc', cursor: 1 };
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.commitPaste('line1\nline2');
    expect(builder.registerPaste).toHaveBeenCalledWith('line1\nline2');
    expect(refs.tokenPreviewsRef.current.get('[pasted:N]')).toBe('line1\nline2');
    expect(refs.setDraft).toHaveBeenCalledWith('a[pasted:N]bc', 1 + '[pasted:N]'.length);
  });

  it('collapses content when wouldCollapse returns true', async () => {
    const builder = makeBuilder({ wouldCollapse: vi.fn(() => true) });
    builder.registerPaste = vi.fn(async () => '[big]');
    const refs = buildHarness();
    refs.builderRef.current = builder;
    refs.draftRef.current = { buffer: 'x', cursor: 1 };
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.commitPaste('very long paste content');
    expect(builder.registerPaste).toHaveBeenCalled();
    expect(refs.setDraft).toHaveBeenCalledWith('x[big]', 1 + '[big]'.length);
  });

  it('does NOT collapse slash command with multi-line content when wouldCollapse is false', async () => {
    const refs = buildHarness();
    refs.builderRef.current = makeBuilder({ wouldCollapse: vi.fn(() => false) });
    refs.draftRef.current = { buffer: '/fix', cursor: 4 };
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.commitPaste('error\ndetails');
    // Slash command with multi-line but not collapsing → inlined as raw text
    expect(refs.setDraft).toHaveBeenCalledWith('/fixerror\ndetails', 4 + 'error\ndetails'.length);
  });

  it('collapses slash command paste when wouldCollapse returns true', async () => {
    const builder = makeBuilder({ wouldCollapse: vi.fn(() => true) });
    builder.registerPaste = vi.fn(async (_full: string) => '[pasted]');
    const refs = buildHarness();
    refs.builderRef.current = builder;
    refs.draftRef.current = { buffer: '/fix', cursor: 4 };
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.commitPaste('very long error text that exceeds collapse threshold');
    // Collapse-worthy even for slash command → gets tokenized
    expect(builder.registerPaste).toHaveBeenCalled();
    expect(refs.setDraft).toHaveBeenCalledWith('/fix[pasted]', 4 + '[pasted]'.length);
  });

  it('accepts paste content exactly at the existing character cap', async () => {
    const builder = makeBuilder({ wouldCollapse: vi.fn(() => true) });
    const refs = buildHarness();
    refs.builderRef.current = builder;
    render(React.createElement(Harness, { refs }));

    await refs.result.current!.commitPaste('x'.repeat(MAX_PASTE_CHARS));

    expect(builder.registerPaste).toHaveBeenCalled();
    expect(refs.dispatch).not.toHaveBeenCalled();
  });

  it('rejects paste content over the existing character cap without registration', async () => {
    const builder = makeBuilder({ wouldCollapse: vi.fn(() => true) });
    const refs = buildHarness();
    refs.builderRef.current = builder;
    render(React.createElement(Harness, { refs }));

    await refs.result.current!.commitPaste('x'.repeat(MAX_PASTE_CHARS + 1));

    expect(builder.registerPaste).not.toHaveBeenCalled();
    expect(refs.setDraft).not.toHaveBeenCalled();
    expect(refs.dispatch).toHaveBeenCalledWith({
      type: 'addEntry',
      entry: { kind: 'error', text: expect.stringContaining('Paste rejected') },
    });
  });

  it('inserts short single-line content inline', async () => {
    const refs = buildHarness();
    refs.builderRef.current = makeBuilder({ wouldCollapse: vi.fn(() => false) });
    refs.draftRef.current = { buffer: 'prefix', cursor: 6 };
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.commitPaste(' inline');
    expect(refs.setDraft).toHaveBeenCalledWith('prefix inline', 6 + ' inline'.length);
  });
});

// ── pasteClipboardImage ───────────────────────────────────────────────

describe('pasteClipboardImage', () => {
  it('does nothing when builder is null', async () => {
    const refs = buildHarness();
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.pasteClipboardImage();
    expect(refs.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches info when clipboard has no image', async () => {
    vi.spyOn(clipboardModule, 'readClipboardImage').mockResolvedValue(null);
    const refs = buildHarness();
    refs.builderRef.current = makeBuilder();
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.pasteClipboardImage();
    expect(refs.dispatch).toHaveBeenCalledWith({
      type: 'addEntry',
      entry: { kind: 'info', text: 'No image on the clipboard.' },
    });
  });

  it('registers image and inserts token', async () => {
    vi.spyOn(clipboardModule, 'readClipboardImage').mockResolvedValue({
      base64: 'abc123',
      mediaType: 'image/png',
      bytes: 20480,
    });
    const builder = makeBuilder();
    builder.registerImage = vi.fn(async () => '[img]');
    const refs = buildHarness();
    refs.builderRef.current = builder;
    refs.draftRef.current = { buffer: 'a', cursor: 1 };
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.pasteClipboardImage();
    expect(builder.registerImage).toHaveBeenCalledWith('abc123', 'image/png');
    expect(refs.tokenPreviewsRef.current.get('[img]')).toBe('image, 20 KB');
    expect(refs.setDraft).toHaveBeenCalledWith('a[img]', 1 + '[img]'.length);
  });

  it('dispatches error when readClipboardImage throws', async () => {
    vi.spyOn(clipboardModule, 'readClipboardImage').mockRejectedValue(
      new Error('permission denied'),
    );
    const refs = buildHarness();
    refs.builderRef.current = makeBuilder();
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.pasteClipboardImage();
    expect(refs.dispatch).toHaveBeenCalledWith({
      type: 'addEntry',
      entry: { kind: 'error', text: 'Clipboard image error: permission denied' },
    });
  });
});

// ── pasteClipboardText ────────────────────────────────────────────────

describe('pasteClipboardText', () => {
  it('dispatches info when clipboard has no text', async () => {
    vi.spyOn(clipboardModule, 'readClipboardText').mockResolvedValue(null);
    const refs = buildHarness();
    refs.builderRef.current = makeBuilder();
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.pasteClipboardText();
    expect(refs.dispatch).toHaveBeenCalledWith({
      type: 'addEntry',
      entry: { kind: 'info', text: 'No text on the clipboard.' },
    });
  });

  it('commits text via commitPaste', async () => {
    vi.spyOn(clipboardModule, 'readClipboardText').mockResolvedValue('clipboard content');
    const refs = buildHarness();
    refs.builderRef.current = makeBuilder();
    refs.draftRef.current = { buffer: '', cursor: 0 };
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.pasteClipboardText();
    expect(refs.setDraft).toHaveBeenCalled();
  });

  it('dispatches error when readClipboardText throws', async () => {
    vi.spyOn(clipboardModule, 'readClipboardText').mockRejectedValue(new Error('clipboard error'));
    const refs = buildHarness();
    refs.builderRef.current = makeBuilder();
    render(React.createElement(Harness, { refs }));
    await refs.result.current!.pasteClipboardText();
    expect(refs.dispatch).toHaveBeenCalledWith({
      type: 'addEntry',
      entry: { kind: 'error', text: 'Clipboard error: clipboard error' },
    });
  });
});
