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
import { useEffect } from 'react';
import { InputBuilder } from '@wrongstack/core';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { Action, State } from '../app-reducer.js';
import { searchFiles } from '../file-search.js';

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

export interface UseFileSearchOptions {
  state: State;
  dispatch: React.Dispatch<Action>;
  projectRoot: string;
  builderRef: React.MutableRefObject<InputBuilder | null>;
  draftRef: React.MutableRefObject<{ buffer: string; cursor: number }>;
  setDraft: (buffer: string, cursor: number) => void;
  tokenPreviewsRef: React.MutableRefObject<Map<string, string>>;
}

export interface FileSearchResult {
  /** Called from the host's Enter handler when the file picker is open. */
  onPickerEnter: () => Promise<void>;
}

/**
 * Watches buffer/cursor for `@<query>` tokens, drives file search, and
 * provides the Enter handler for the <FilePicker> component.
 */
export function useFileSearch(options: UseFileSearchOptions): FileSearchResult {
  const { state, dispatch, projectRoot, builderRef, draftRef, setDraft, tokenPreviewsRef } = options;

  // ── @-token detection + file search ──────────────────────────────
  useEffect(() => {
    const detected = detectAtToken(state.buffer, state.cursor);
    if (!detected) {
      if (state.picker.open) dispatch({ type: 'pickerClose' });
      return;
    }
    if (!state.picker.open || state.picker.query !== detected.query) {
      dispatch({ type: 'pickerOpen', query: detected.query });
    }
    let cancelled = false;
    searchFiles(projectRoot, detected.query, 8)
      .then((matches) => {
        if (!cancelled) {
          dispatch({ type: 'pickerSetMatches', query: detected.query, matches });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
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
      const data = await fs.readFile(absPath, 'utf8');
      const token = await builder.registerFile({
        kind: 'file',
        data,
        meta: { filename: picked, label: picked },
      });
      // Store the full file content so slash commands like /fix can resolve
      // @-mention tokens to their actual text instead of just the placeholder.
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
