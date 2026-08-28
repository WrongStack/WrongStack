/**
 * File-search hook — @-token detection, file search, and file picker
 * selection handler. Extracted from app.tsx (Issue #23, PR 4).
 *
 * Drives the <FilePicker /> component: watches buffer/cursor for an
 * active `@<query>` token, calls searchFiles(), dispatches matches,
 * and on Enter/click registers the picked file as an attachment.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { InputBuilder } from '@wrongstack/core/agent';
import { toErrorMessage } from '@wrongstack/core/utils';
import { useEffect } from 'react';
import type { Action, State } from '../app-reducer.js';
import { searchFiles } from '../file-search.js';
import {
  TEXT_FILE_ATTACHMENT_INLINE_MAX_BYTES,
  type TokenPreviewStore,
} from '../token-previews.js';

/**
 * Keystroke coalescing window for `@`-file search. Long enough to swallow a
 * burst of typing, short enough that the results feel attached to the keys.
 */
const FILE_SEARCH_DEBOUNCE_MS = 150;

// ── Exported helpers (pure, no hook dependency) ─────────────────────

/**
 * Find an active `@<query>` token at the cursor. The token starts at the
 * last `@` not preceded by a non-whitespace char, and runs up to the cursor
 * (no whitespace allowed inside). Returns null if no active token.
 */
export function detectAtToken(
  buffer: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  let i = cursor - 1;
  while (i >= 0) {
    const ch = buffer.charCodeAt(i);
    if (ch === 64 /* @ */) {
      // Must be at the start of buffer or preceded by whitespace.
      if (i === 0 || /\s/.test(buffer[i - 1] ?? '')) {
        return { start: i, end: cursor, query: buffer.slice(i + 1, cursor) };
      }
      return null;
    }
    if (ch === 32 /* space */ || ch === 9 /* tab */ || ch === 10 /* nl */) return null;
    i--;
  }
  return null;
}

// ── Hook ────────────────────────────────────────────────────────────

interface UseFileSearchOptions {
  state: State;
  dispatch: React.Dispatch<Action>;
  projectRoot: string;
  builderRef: React.MutableRefObject<InputBuilder | null>;
  draftRef: React.MutableRefObject<{ buffer: string; cursor: number }>;
  setDraft: (buffer: string, cursor: number) => void;
  tokenPreviewsRef: React.MutableRefObject<TokenPreviewStore>;
}

interface FileSearchResult {
  /** Called from the host's Enter handler when the file picker is open. */
  onPickerEnter: () => Promise<void>;
}

/**
 * Watches buffer/cursor for `@<query>` tokens, drives file search, and
 * provides the Enter handler for the <FilePicker> component.
 */
export function useFileSearch(options: UseFileSearchOptions): FileSearchResult {
  const { state, dispatch, projectRoot, builderRef, draftRef, setDraft, tokenPreviewsRef } =
    options;

  // ── @-token detection + file search ──────────────────────────────
  useEffect(() => {
    const detected = detectAtToken(state.buffer, state.cursor);
    if (!detected) {
      if (state.picker.open) dispatch({ type: 'pickerClose' });
      return;
    }
    const justOpened = !state.picker.open;
    if (justOpened || state.picker.query !== detected.query) {
      dispatch({ type: 'pickerOpen', query: detected.query });
    }
    let cancelled = false;
    const run = () => {
      searchFiles(projectRoot, detected.query, 8)
        .then((matches) => {
          if (!cancelled) {
            dispatch({ type: 'pickerSetMatches', query: detected.query, matches });
          }
        })
        .catch(() => undefined);
    };

    // `searchFiles` fuzzy-scores every indexed path (up to FILE_INDEX_MAX) and
    // each result dispatches a picker re-render. Typing `@compo` used to pay
    // that five times. Debounce so a fast typist pays it once — but keep the
    // first keystroke immediate, or the picker would visibly lag the `@`.
    if (justOpened) {
      run();
      return () => {
        cancelled = true;
      };
    }
    const timer = setTimeout(run, FILE_SEARCH_DEBOUNCE_MS);
    timer.unref?.();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.buffer, state.cursor, projectRoot]);

  // ── File picker selection handler ────────────────────────────────
  const acceptPickerSelection = async (): Promise<void> => {
    const { open, matches, selected } = state.picker;
    if (!open || matches.length === 0) return;
    const picked = matches[selected];
    if (!picked) return;
    const builder = builderRef.current;
    if (!builder) return;

    // Find the @-token span we're replacing.
    const draft = draftRef.current;
    const tok = detectAtToken(draft.buffer, draft.cursor);
    if (!tok) {
      dispatch({ type: 'pickerClose' });
      return;
    }

    // Register the file (no builder display mutation) and put a path-keyed
    // `[file:<path>]` token inline in the visible buffer (replacing @query).
    // The buffer is the single source of truth — the token expands back to the
    // file content at submit via the store's path lookup.
    const absPath = path.isAbsolute(picked) ? picked : path.join(projectRoot, picked);
    try {
      const stat = await fs.stat(absPath);
      let data: string;
      if (stat.size > TEXT_FILE_ATTACHMENT_INLINE_MAX_BYTES) {
        // Do not read a potentially huge file into the TUI merely to attach
        // it. Keep the project-relative path and give the agent a concrete,
        // provider-bound contract to read every chunk before acting.
        data = fileReadContract(picked, stat.size);
      } else {
        const inline = await fs.readFile(absPath, 'utf8');
        const bytes = Buffer.byteLength(inline, 'utf8');
        data =
          bytes > TEXT_FILE_ATTACHMENT_INLINE_MAX_BYTES ? fileReadContract(picked, bytes) : inline;
      }
      const token = await builder.registerFile({
        kind: 'file',
        data,
        meta: { filename: picked, label: picked },
      });
      // Retain only a bounded display preview. Slash commands and BTW resolve
      // full file text on demand from the canonical AttachmentStore.
      tokenPreviewsRef.current.set(token, data);
      const before = draft.buffer.slice(0, tok.start);
      const after = draft.buffer.slice(tok.end);
      const next = `${before}${token}${after}`;
      setDraft(next, tok.start + token.length);
      dispatch({ type: 'pickerClose' });
    } catch (err) {
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'error',
          text: `Attach failed: ${toErrorMessage(err)}`,
        },
      });
      dispatch({ type: 'pickerClose' });
    }
  };

  return { onPickerEnter: acceptPickerSelection };
}

function fileReadContract(filePath: string, bytes: number): string {
  return [
    '[File reference contract]',
    `Referenced project file: ${JSON.stringify(filePath)} (${bytes.toLocaleString()} bytes; content not inlined).`,
    'Before answering or modifying anything related to this reference, use the available file-reading tools to read the complete file.',
    'If a read is paginated or chunked, continue from the same path until EOF. Do not treat a partial read or preview as the complete file.',
  ].join('\n');
}
