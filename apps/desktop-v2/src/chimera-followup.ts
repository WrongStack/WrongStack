import type { EngineState } from './engine-state';

export function chimeraFollowup(reportId: string): string {
  return `Review Chimera report ${JSON.stringify(reportId)} for this conversation. Read its current findings, citation verification and activity. Validate each finding against current code, follow the normal permission flow, and record outcomes after verification.`;
}

/** Refuse to replace unrelated work; the saved composer performs actual sending/refinement. */
export function chimeraFollowupState(
  state: Pick<EngineState, 'messages' | 'running' | 'connected' | 'synced'>,
  reportId: string,
  draft: string,
  mediaCount: number,
): 'sent' | 'prepared' | 'running' | 'offline' | 'draft' | null {
  const prompt = chimeraFollowup(reportId);
  if (
    state.messages.some(
      (message) =>
        message.role === 'user' && (message.text === prompt || message.journalRaw === prompt),
    )
  )
    return 'sent';
  if (draft === prompt) return 'prepared';
  if (!state.connected || !state.synced) return 'offline';
  if (state.running) return 'running';
  if (draft.trim() || mediaCount) return 'draft';
  return null;
}
