import { useCallback, useEffect, useState } from 'react';
import { removeFileMention, type FileMention } from '../lib/file-mention.js';
import type { SimpleSocket } from '../lib/ws.js';

export interface UseFileMentionOptions {
  socketRef: React.RefObject<SimpleSocket | null>;
}

export interface UseFileMentionResult {
  fileMention: FileMention | null;
  setFileMention: React.Dispatch<React.SetStateAction<FileMention | null>>;
  fileMatches: string[];
  setFileMatches: React.Dispatch<React.SetStateAction<string[]>>;
  filePickerIndex: number;
  setFilePickerIndex: React.Dispatch<React.SetStateAction<number>>;
  fileSearching: boolean;
  setFileSearching: React.Dispatch<React.SetStateAction<boolean>>;
  /** Pick a file from the picker: removes the `@query` mention from the
   *  draft and returns the updated text + fileRefs so the caller can
   *  apply them to its own state. */
  selectFile: (
    path: string,
    draft: string,
    fileRefs: string[],
  ) => {
    draft: string;
    fileRefs: string[];
  };
}

/**
 * Owns the `@`-triggered file picker: the mention query, the match list,
 * the 80ms debounce that sends `files.list` to the server, and the
 * `fileSearching` lifecycle flag.
 *
 * Behavioural contract (must survive the PR-5 extraction from `app.tsx`):
 *  - The debounce fires only when `fileMention` is non-null.
 *  - The debounce period is 80ms; rapid typing collapses to a single
 *    `files.list` frame carrying the latest query.
 *  - `fileSearching` flips to `true` when the debounce schedules a request
 *    and back to `false` when `fileMention` is cleared (server response
 *    sets `fileMatches`, but the flag is cleared locally when the picker
 *    closes).
 *  - `selectFile` is a pure projection: it removes the mention text from
 *    the draft and adds the path to `fileRefs`. The caller owns the state
 *    — this hook returns the new values rather than mutating them directly.
 */
export function useFileMention(options: UseFileMentionOptions): UseFileMentionResult {
  const { socketRef } = options;

  const [fileMention, setFileMention] = useState<FileMention | null>(null);
  const [fileMatches, setFileMatches] = useState<string[]>([]);
  const [filePickerIndex, setFilePickerIndex] = useState(0);
  const [fileSearching, setFileSearching] = useState(false);

  useEffect(() => {
    if (!fileMention) {
      setFileSearching(false);
      return;
    }
    setFileSearching(true);
    const timer = setTimeout(() => {
      socketRef.current?.send('files.list', { query: fileMention.query, limit: 12 });
    }, 80);
    return () => clearTimeout(timer);
  }, [fileMention, socketRef]);

  const selectFile = useCallback(
    (path: string, draft: string, fileRefs: string[]) => {
      const mention = fileMention;
      const updatedDraft = mention ? removeFileMention(draft, mention) : draft;
      return {
        draft: updatedDraft,
        fileRefs: [...fileRefs, path],
      };
    },
    [fileMention],
  );

  return {
    fileMention,
    setFileMention,
    fileMatches,
    setFileMatches,
    filePickerIndex,
    setFilePickerIndex,
    fileSearching,
    setFileSearching,
    selectFile,
  };
}
