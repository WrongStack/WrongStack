import { useState } from 'react';
import { CommandPalette } from '@/components/CommandPalette';
import { SddTaskDrawer } from '@/components/SddTaskDrawer';
import { SearchOverlay } from '@/components/SearchOverlay';
import { Button } from '@/components/ui/button';
import { type BoardTaskItem, useChatStore, useLocalPrefs, useUIStore } from '@/stores';
import { seedOverlayReview } from './OverlayReviewWorkbench';

const longName = 'Workspace_review_evidence_'.repeat(9);
const shortTask: BoardTaskItem = {
  id: 'navigation-task',
  shortId: 'T-42',
  title: 'Review workspace',
  description: 'Inspect the project and record the result.',
  priority: 'high',
  type: 'test',
  status: 'pending',
  displayStatus: 'pending',
  deps: [],
  agentName: 'Review agent',
};

export function seedNavigationReview() {
  seedOverlayReview();
  useLocalPrefs.getState().set({ keyboardShortcuts: true });
  useChatStore.setState({
    messages: [
      {
        id: 'navigation-first',
        role: 'user',
        content: 'Review the workspace layout.',
        timestamp: 1,
      },
      {
        id: 'navigation-second',
        role: 'assistant',
        content: 'The workspace review is ready.',
        timestamp: 2,
      },
    ],
  });
}

export function NavigationReviewWorkbench() {
  const [taskMode, setTaskMode] = useState<'short' | 'long' | 'expanded' | null>(null);
  const task: BoardTaskItem =
    taskMode === 'short'
      ? shortTask
      : {
          ...shortTask,
          title: longName,
          description: `https://example.test/artifacts/${'a'.repeat(180)}`,
          agentName: `review_agent_${'workspace_'.repeat(12)}`,
          worktreeBranch: `review/${longName}`,
          verificationCommand: 'bun run typecheck',
          verificationState: 'passed',
        };
  const noOp = () => {};
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-3" data-testid="navigation-review">
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button
          onClick={() => {
            setTaskMode(null);
            useUIStore.getState().setSearchOpen(true);
          }}
        >
          Search conversation
        </Button>
        <Button onClick={() => useUIStore.getState().setPaletteOpen(true)}>
          Open command palette
        </Button>
        <Button onClick={() => setTaskMode('short')}>Short task control</Button>
        <Button onClick={() => setTaskMode('long')}>Long task content</Button>
        <Button onClick={() => setTaskMode('expanded')}>Expanded task content</Button>
      </div>
      {taskMode ? (
        <div
          className={`min-h-0 min-w-0 flex-1 border ${taskMode === 'expanded' ? '' : 'max-w-md'}`}
          data-testid="task-review"
        >
          <SddTaskDrawer
            task={task}
            allTasks={[task]}
            feed={[]}
            now={1000}
            expanded={taskMode === 'expanded'}
            modelCandidates={[]}
            onClose={() => setTaskMode(null)}
            onToggleExpanded={() => setTaskMode(taskMode === 'expanded' ? 'long' : 'expanded')}
            onRetry={noOp}
            onReassign={noOp}
            onSetModel={noOp}
            onSetVerification={noOp}
            onCancel={noOp}
            onDelete={noOp}
            onSplit={noOp}
            onSelectTask={noOp}
          />
        </div>
      ) : (
        <div
          className="relative min-h-0 flex-1 overflow-auto border p-3"
          data-testid="search-review"
        >
          <p data-message-id="navigation-first" className="mt-16">
            Review the workspace layout.
          </p>
          <p data-message-id="navigation-second" className="mt-6">
            The workspace review is ready.
          </p>
          <SearchOverlay />
        </div>
      )}
      <textarea
        data-chat-textarea
        aria-label="Review message"
        className="h-12 shrink-0 border bg-background p-2"
      />
      <CommandPalette />
    </div>
  );
}
