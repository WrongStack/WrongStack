import { useEffect } from 'react';
import { journalRecallTexts, RECALL_JOURNAL_LIMIT } from './journal-recall';
import { projectRequest } from './journal-tail';
import { RuntimeGate } from './RuntimeGate';

/**
 * Reads the project's newest original prompts for up-arrow recall through the project engine
 * (project resources never go through a conversation engine), reports them once, and is then
 * removed by its owner. It asks on the journal's live end: opening a conversation must not
 * replay the project's whole journal just to learn that its engine is connected.
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
  useEffect(() => {
    let active = true;
    void projectRequest(
      projectId,
      'prompts.journal',
      { filter: { limit: RECALL_JOURNAL_LIMIT, category: 'raw_user' } },
      ['prompts.journal'],
    )
      .then((result) => {
        if (active) onLoad(journalRecallTexts(result));
      })
      .catch(() => {
        // Without a journal, recall stays within the conversation.
        if (active) onLoad([]);
      });
    return () => {
      active = false;
    };
  }, [projectId, onLoad]);
  return null;
}
