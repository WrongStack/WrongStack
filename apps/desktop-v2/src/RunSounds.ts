import { playCompletionChime, playPermissionChime } from '@wrongstack/project-surfaces/lib/chime';
import { useEffect, useRef } from 'react';
import type { EngineState } from './engine-state';

/**
 * The WebUI's run sounds for the open conversation: a soft chime when a run finishes (when
 * Appearance > Sounds is on) and an insistent one whenever a tool asks for approval. Only what
 * happens while the conversation is open sounds; history read from the journal stays quiet.
 */
export function useRunSounds(state: EngineState) {
  const result = state.results['run.result'];
  const approvals = state.approvals.length;
  const live = state.connected && !state.hydrating;
  const seen = useRef({ session: state.sessionId, result, approvals });
  useEffect(() => {
    const previous = seen.current;
    seen.current = { session: state.sessionId, result, approvals };
    if (!live || previous.session !== state.sessionId) return;
    try {
      if (approvals > previous.approvals) playPermissionChime();
      else if (
        result !== previous.result &&
        result?.['status'] === 'done' &&
        document.documentElement.dataset['sound'] === 'on'
      )
        playCompletionChime();
    } catch {
      // The audio policy can refuse; a missing chime is never an error.
    }
  }, [result, approvals, live, state.sessionId]);
}
