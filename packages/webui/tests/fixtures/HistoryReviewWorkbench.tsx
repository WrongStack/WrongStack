import { useState } from 'react';
import { SessionList } from '@/components/SidePanel/SessionList';
import { Button } from '@/components/ui/button';
import type { SessionHistoryEntry } from '@/stores';
import { useUIStore } from '@/stores';

const actions: { type: string; id?: string; name?: string }[] = [];
export function seedHistoryReview() {
  actions.length = 0;
  useUIStore.setState({ favoriteSessionIds: [], sessionNicknames: {} });
  return { historyActions: actions };
}

export function HistoryReviewWorkbench() {
  const [query, setQuery] = useState('');
  const [sidebar, setSidebar] = useState(false);
  const [many, setMany] = useState(false);
  const now = Date.now();
  const base: SessionHistoryEntry = {
    id: 'history-recent',
    title: 'Recent workspace check',
    provider: 'workspace-provider',
    model: 'workspace-model',
    tokenTotal: 10,
    toolCallCount: 1,
    fileChangeCount: 0,
    startedAt: new Date(now - 120_000).toISOString(),
    endedAt: new Date(now - 60_000).toISOString(),
    isCurrent: false,
    outcome: 'completed',
  };
  const entries: SessionHistoryEntry[] = [
    base,
    {
      ...base,
      id: 'history-older',
      title: 'Older detailed investigation',
      tokenTotal: 9000,
      toolCallCount: 50,
      fileChangeCount: 8,
      startedAt: new Date(now - 40 * 86_400_000).toISOString(),
      endedAt: new Date(now - 40 * 86_400_000 + 60_000).toISOString(),
    },
    {
      ...base,
      id: 'history-long',
      title: 'Workspace_review_evidence_'.repeat(6),
      tokenTotal: 2000,
      toolCallCount: 20,
      lastUserMessage: 'https://example.test/artifacts/' + 'evidence_'.repeat(18),
      startedAt: new Date(now - 10 * 86_400_000).toISOString(),
      endedAt: new Date(now - 10 * 86_400_000 + 60_000).toISOString(),
    },
    ...(many
      ? Array.from({ length: 23 }, (_, i) => ({
          ...base,
          id: `history-extra-${i}`,
          title: `Recorded workspace ${i + 1}`,
        }))
      : []),
  ];
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="history-review">
      <div className="flex shrink-0 flex-wrap gap-2 border-b p-2">
        <Button onClick={() => setSidebar((v) => !v)}>Toggle sidebar variant</Button>
        <Button onClick={() => setMany((v) => !v)}>Toggle large history</Button>
      </div>
      <div className={`flex min-h-0 min-w-0 flex-1 ${sidebar ? 'max-w-[300px]' : ''}`}>
        <SessionList
          historyQuery={query}
          setHistoryQuery={setQuery}
          historyEntries={entries}
          historyLoading={false}
          historyError={null}
          wsConnected
          listSessions={() => actions.push({ type: 'list' })}
          resumeSession={(id) => actions.push({ type: 'resume', id })}
          deleteSession={(id) => actions.push({ type: 'delete', id })}
          renameSession={(id, name) => actions.push({ type: 'rename', id, name })}
          variant={sidebar ? 'sidebar' : 'workspace'}
        />
      </div>
    </div>
  );
}
