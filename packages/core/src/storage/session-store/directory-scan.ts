export function shouldSkipSessionDirectoryEntry(name: string): boolean {
  return (
    (name.startsWith('.') && name !== '.wrongstack') ||
    name === 'shared' ||
    name === 'subagents' ||
    name === 'attachments'
  );
}

/**
 * Re-exported under the store's own name; the rule itself lives with
 * `sessionScopedPath`, which is what writes the sidecars this excludes.
 */
export { isSessionTranscriptFileName as isSessionJsonlFileName } from '../../utils/session-scoped-path.js';
