import { useRef } from 'react';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { InputBuilder } from '@wrongstack/core/agent';
import type { Action } from '../app-reducer.js';
import { readClipboardImage, readClipboardText } from '../clipboard.js';
import { validatePasteContent } from '../input-validation.js';
import type { PasteAccumState } from '../paste-accumulator.js';
import type { TokenPreviewStore } from '../token-previews.js';

export interface UsePasteHandlingOptions {
  builderRef: React.MutableRefObject<InputBuilder | null>;
  dispatch: React.Dispatch<Action>;
  draftRef: React.MutableRefObject<{ buffer: string; cursor: number }>;
  setDraft: (buffer: string, cursor: number) => void;
  tokenPreviewsRef: React.MutableRefObject<TokenPreviewStore>;
}

interface PasteHandlingResult {
  pasteAccumRef: React.MutableRefObject<PasteAccumState>;
  pasteFlushTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  commitPaste: (full: string) => Promise<void>;
  pasteClipboardImage: () => Promise<void>;
  pasteClipboardText: () => Promise<void>;
}

/**
 * Bracketed-paste accumulator and clipboard paste handling.
 *
 * A single paste can be delivered across several stdin/keypress events: only
 * the first carries the \x1b[200~ begin marker and only the last carries
 * \x1b[201~. We buffer every fragment here between those markers and finalize
 * once, so a paste never fragments into multiple placeholders or leaks
 * newlines into the buffer.
 */
export function usePasteHandling({
  builderRef,
  dispatch,
  draftRef,
  setDraft,
  tokenPreviewsRef,
}: UsePasteHandlingOptions): PasteHandlingResult {
  // `null` means "not currently inside a paste".
  const pasteAccumRef = useRef<PasteAccumState>(null);
  // Safety net: if the closing \x1b[201~ marker never arrives (a terminal
  // dropped it, or Ink split the escape across chunks), flush the buffered
  // payload after a short idle period so accumulation can't swallow input
  // indefinitely. Real pastes deliver all fragments back-to-back, well
  // inside this window.
  const pasteFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Finalize a fully-assembled paste payload. A collapse-worthy paste (long
  // or many-lined) or any multi-line paste becomes an inline `[pasted #N, L
  // lines]` chip in the editable row — the content lives in the AttachmentStore
  // and is expanded from the buffer at submit. A short single-line paste is
  // inserted straight into the row as raw text so the user can see and edit it.
  //
  // Exception: when the buffer starts with `/` (slash command), the paste
  // content is the command's argument — collapsing it to a chip would make
  // commands like `/fix` classify the placeholder text instead of the actual
  // error. Still collapse only truly massive pastes (>collapse threshold)
  // since they won't fit a CLI command line anyway.
  const commitPaste = async (full: string): Promise<void> => {
    const builder = builderRef.current;
    if (!builder || !full) return;
    const validation = validatePasteContent(full);
    if (!validation.valid) {
      dispatch({
        type: 'addEntry',
        entry: { kind: 'error', text: `Paste rejected: ${validation.error}` },
      });
      return;
    }
    const { buffer, cursor } = draftRef.current;
    const isSlashCmd = buffer.trimStart().startsWith('/');
    const mustCollapse = builder.wouldCollapse(full);
    const multiLine = full.includes('\n');

    if (isSlashCmd && !mustCollapse) {
      // Slash command: inline the paste so the command handler sees the real
      // content instead of a `[pasted #N]` placeholder. Multi-line content is
      // fine — slash command args span the rest of the line, newlines included.
      const next = buffer.slice(0, cursor) + full + buffer.slice(cursor);
      setDraft(next, cursor + full.length);
      return;
    }

    if (mustCollapse || multiLine) {
      // Register-only: store the paste, get back the inline token. The token
      // goes into the buffer (single source of truth); nothing is appended to
      // the builder's own display, so there's no double-expansion at submit.
      const token = await builder.registerPaste(full);
      // Retain only a bounded display preview. Slash commands and BTW resolve
      // the full payload on demand from the canonical AttachmentStore.
      tokenPreviewsRef.current.set(token, full);
      const next = buffer.slice(0, cursor) + token + buffer.slice(cursor);
      setDraft(next, cursor + token.length);
      return;
    }
    const next = buffer.slice(0, cursor) + full + buffer.slice(cursor);
    setDraft(next, cursor + full.length);
  };

  const pasteClipboardImage = async (): Promise<void> => {
    const builder = builderRef.current;
    if (!builder) return;
    try {
      const img = await readClipboardImage();
      if (!img) {
        dispatch({
          type: 'addEntry',
          entry: { kind: 'info', text: 'No image on the clipboard.' },
        });
        return;
      }
      // Register-only: the token goes inline into the editable buffer (like a
      // pasted block) so it renders as a chip and expands from the buffer at
      // submit — not into a separate pill above the input.
      const token = await builder.registerImage(img.base64, img.mediaType);
      const kb = (img.bytes / 1024).toFixed(0);
      tokenPreviewsRef.current.set(token, `image, ${kb} KB`);
      const { buffer, cursor } = draftRef.current;
      const next = buffer.slice(0, cursor) + token + buffer.slice(cursor);
      setDraft(next, cursor + token.length);
    } catch (err) {
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'error',
          text: `Clipboard image error: ${toErrorMessage(err)}`,
        },
      });
    }
  };

  // Ctrl+V → read text from the system clipboard and insert it. In raw mode the
  // terminal hands Ctrl+V to us as a control byte instead of doing a native
  // paste. Bracketed-paste mode IS enabled (run-tui.ts writes \x1b[?2004h at
  // startup), so most terminals wrap pastes in \x1b[200~...\x1b[201~ markers
  // handled by the accumulator in app.tsx. This Ctrl+V path is the fallback for
  // terminals that intercept Ctrl+V for their own native paste (sending the raw
  // content without markers) or don't support bracketed paste mode at all.
  // Route through commitPaste so long/multi-line content collapses to a
  // [pasted #N] chip exactly like a bracketed paste would.
  const pasteClipboardText = async (): Promise<void> => {
    try {
      const text = await readClipboardText();
      if (!text) {
        dispatch({
          type: 'addEntry',
          entry: { kind: 'info', text: 'No text on the clipboard.' },
        });
        return;
      }
      await commitPaste(text);
    } catch (err) {
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'error',
          text: `Clipboard error: ${toErrorMessage(err)}`,
        },
      });
    }
  };

  return {
    pasteAccumRef,
    pasteFlushTimerRef,
    commitPaste,
    pasteClipboardImage,
    pasteClipboardText,
  };
}
