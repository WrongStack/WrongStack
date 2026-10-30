import { useState } from 'react';
import { ConfirmModalHost, confirmModalChoice } from '@/components/ConfirmModal';
import { SessionInspectView } from '@/components/SessionInspectView';
import { Button } from '@/components/ui/button';
import { getWSClient } from '@/lib/ws-client';
import { useUIStore } from '@/stores';
import type { useSessionInspectStore } from '@/stores/session-inspect-store';

type InspectData = Parameters<ReturnType<typeof useSessionInspectStore.getState>['setPayload']>[0];
const longName = 'Workspace_review_evidence_'.repeat(6);
function inspection(id: string): InspectData {
  const long = id === 'inspection-long';
  return {
    id,
    title: long ? longName : 'Workspace inspection',
    provider: long ? `workspace_${'production_'.repeat(8)}` : 'workspace-provider',
    model: long ? longName : 'workspace-model',
    startedAt: '2026-10-29T12:00:00Z',
    endedAt: '2026-10-29T12:05:00Z',
    tokenTotal: 1200,
    outcome: 'completed',
    messageCount: 3,
    iterationCount: 2,
    toolCallCount: 2,
    toolErrorCount: 0,
    fileChangeCount: 1,
    compactionCount: 0,
    toolBreakdown: { [long ? `mcp__workspace__${longName}` : 'read']: 2 },
    events: [
      {
        ts: '2026-10-29T12:00:00Z',
        type: 'user_input',
        label: 'Review workspace',
        detail: 'Check the project',
      },
      {
        ts: '2026-10-29T12:01:00Z',
        type: 'tool_call_end',
        label: 'Read source file',
        detail: long ? longName : 'src/app.ts',
      },
    ],
    fileEvents: [
      {
        operation: 'update',
        filePath: long ? `src/${longName}.ts` : 'src/app.ts',
        toolName: long ? `mcp__workspace__${longName}` : 'edit',
        ts: '2026-10-29T12:02:00Z',
      },
    ],
    lastUserMessage: 'Review the workspace and record the evidence.',
  };
}

export function seedInspectionReview() {
  const client = getWSClient();
  const handlers = new Map<string, Set<(message: unknown) => void>>();
  client.on = ((type: string, handler: (message: unknown) => void) => {
    const set = handlers.get(type) ?? new Set();
    set.add(handler);
    handlers.set(type, set);
    return () => set.delete(handler);
  }) as typeof client.on;
  client.off = ((type: string, handler: (message: unknown) => void) =>
    handlers.get(type)?.delete(handler)) as typeof client.off;
  client.send = ((message: { type: string; payload?: { id?: string } }) => {
    if (message.type === 'session.inspect' && message.payload?.id) {
      const payload = inspection(message.payload.id);
      queueMicrotask(() => {
        for (const handler of handlers.get('session.inspect') ?? [])
          handler({ type: 'session.inspect', payload });
      });
    }
    return true;
  }) as typeof client.send;
  useUIStore.getState().setInspectSession('inspection-short');
}

export function InspectionReviewWorkbench() {
  const [decision, setDecision] = useState('pending');
  const openConfirm = (defaultAction: 'confirm' | 'cancel') => {
    setDecision('pending');
    void confirmModalChoice({
      title: 'Review removal',
      message: 'Choose the focused action.',
      confirmLabel: 'Remove record',
      cancelLabel: 'Keep record',
      danger: true,
      defaultAction,
    }).then(setDecision);
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="inspection-review">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-2">
        <Button onClick={() => useUIStore.getState().setInspectSession('inspection-short')}>
          Inspect short content
        </Button>
        <Button onClick={() => useUIStore.getState().setInspectSession('inspection-long')}>
          Inspect long content
        </Button>
        <Button onClick={() => openConfirm('confirm')}>Confirm default</Button>
        <Button onClick={() => openConfirm('cancel')}>Cancel default</Button>
        <output data-testid="confirmation-result">{decision}</output>
      </div>
      <div className="min-h-0 min-w-0 flex-1" data-testid="inspection-panel">
        <SessionInspectView />
      </div>
      <ConfirmModalHost />
    </div>
  );
}
