import { useEffect } from 'react';
import { journalRecallTexts, RECALL_JOURNAL_LIMIT } from './journal-recall';
import { projectRequest } from './journal-tail';
import { request } from './platform';

/**
 * Cross-conversation recall is optional: never boot project services just to populate it.
 * When services are already running, ask on the live end rather than replaying their journal.
 */
export function JournalRecallLoader({
  projectId,
  onLoad,
}: {
  projectId: string;
  onLoad: (prompts: string[]) => void;
}) {
  useEffect(() => {
    let active = true;
    void request<{ status: string }>('project.status', { projectId })
      .then(async ({ status }) => {
        if (!active || status !== 'running') return [];
        const result = await projectRequest(
          projectId,
          'prompts.journal',
          { filter: { limit: RECALL_JOURNAL_LIMIT, category: 'raw_user' } },
          ['prompts.journal'],
        );
        return journalRecallTexts(result);
      })
      // Unavailable project history leaves this conversation's own recall intact.
      .catch(() => [])
      .then((prompts) => {
        if (active) onLoad(prompts);
      });
    return () => {
      active = false;
    };
  }, [projectId, onLoad]);
  return null;
}
