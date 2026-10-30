import { useCallback, useEffect } from 'react';
import { journalRecallTexts, RECALL_JOURNAL_LIMIT } from './journal-recall';
import { RuntimeGate } from './RuntimeGate';
import { useProjectEngine } from './useEngine';

/**
 * Reads the project's newest original prompts for up-arrow recall through the project engine
 * (project resources never go through a conversation engine), reports them once, and is then
 * removed by its owner so the project connection does not keep polling.
 */
export function JournalRecallLoader({
  projectId,
  onLoad,
}: {
  projectId: string;
  onLoad: (prompts: string[]) => void;
}) {
  return (
    <div hidden>
      <RuntimeGate scope="project" projectId={projectId}>
        <Load projectId={projectId} onLoad={onLoad} />
      </RuntimeGate>
    </div>
  );
}

function Load({ projectId, onLoad }: { projectId: string; onLoad: (prompts: string[]) => void }) {
  const ignore = useCallback(() => {
    // Without a journal, recall stays within the conversation.
  }, []);
  const { state, command } = useProjectEngine(projectId, ignore);
  useEffect(() => {
    if (!state.connected) return;
    let active = true;
    void command(
      'prompts.journal',
      { filter: { limit: RECALL_JOURNAL_LIMIT, category: 'raw_user' } },
      ['prompts.journal'],
    )
      .then((result) => {
        if (active) onLoad(journalRecallTexts(result));
      })
      .catch(() => {
        if (active) onLoad([]);
      });
    return () => {
      active = false;
    };
  }, [state.connected, command, onLoad]);
  return null;
}
