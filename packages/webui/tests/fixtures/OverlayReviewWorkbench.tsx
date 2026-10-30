import { useState } from 'react';
import { emptySummary } from '@/components/chronicle-event-detail';
import { ModelPicker } from '@/components/ModelPicker';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { getWSClient } from '@/lib/ws-client';
import { useNotificationStore } from '@/stores/notification-store';
import type { ChronicleEventView } from '@/types';

const artifactName = `${'ReleaseEvidence_'.repeat(14)}.json`;
const description = `https://example.test/artifacts/${'a'.repeat(180)}`;
const candidates = [
  {
    provider: 'visual-fixture',
    model: 'review-model',
    label: 'Workspace review model',
    description: 'A model from the connected account',
  },
  { provider: 'visual-fixture', model: 'build-model', label: 'Workspace build model' },
];

/** Wire-shaped data at the transport seam; all rendered UI remains production code. */
export function seedOverlayReview() {
  useNotificationStore.setState({
    filter: 'all',
    notifications: Array.from({ length: 20 }, (_, i) => ({
      id: `overlay-notification-${i}`,
      message: `Workspace check ${i + 1}: ${i === 0 ? artifactName : 'Review completed; inspect the recorded result.'}`,
      variant: i % 2 ? 'warn' : 'error',
      timestamp: Date.now() - i * 1000,
      read: false,
    })),
  });
  const event: ChronicleEventView = {
    schemaVersion: 1,
    eventId: `event-${'0123456789abcdef'.repeat(4)}`,
    eventType: 'tool.call.completed',
    observedAt: '2026-10-29T12:00:00.000Z',
    persistedAt: '2026-10-29T12:00:00.000Z',
    sequence: 1,
    hash: '0123456789abcdef'.repeat(4),
    previousHash: '',
    outcome: 'success',
    durationNs: '250000000',
    scope: { sessionId: 'visual-session', agentId: 'workspace-review-agent' },
    correlation: { toolCallId: 'visual-tool-call' },
    resource: { kind: 'file', id: artifactName, path: `src/evidence/${artifactName}` },
    attributes: { command: 'bun run typecheck', result: 'No diagnostics found.' },
  };
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
  client.supportsCapability = (capability) => capability === 'chronicle.query';
  client.send = ((message: { type: string }) => {
    if (message.type === 'chronicle.query') {
      queueMicrotask(() => {
        const response = {
          type: 'chronicle.query_result',
          payload: {
            events: [event],
            total: 1,
            scannedEvents: 1,
            sourceFiles: 1,
            invalidLines: 0,
            summary: { ...emptySummary, toolCalls: 1, completedTools: 1 },
          },
        };
        for (const handler of handlers.get(response.type) ?? []) handler(response);
      });
    }
    return true;
  }) as typeof client.send;
}

export function OverlayReviewWorkbench() {
  const [model, setModel] = useState('');
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4" data-testid="overlay-review">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        {[false, true].map((long) => (
          <Dialog key={String(long)}>
            <DialogTrigger asChild>
              <Button>{long ? 'Review long artifact' : 'Review workspace'}</Button>
            </DialogTrigger>
            <DialogContent>
              {long ? (
                <>
                  <DialogTitle>{artifactName}</DialogTitle>
                  <DialogDescription>{description}</DialogDescription>
                </>
              ) : (
                <DialogHeader>
                  <DialogTitle>Review workspace</DialogTitle>
                  <DialogDescription>Inspect the current project.</DialogDescription>
                </DialogHeader>
              )}
              <p className="text-sm">Recorded build evidence is ready for review.</p>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Return to workspace</Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ))}
        <Dialog>
          <DialogTrigger asChild>
            <Button>Configure task model</Button>
          </DialogTrigger>
          <DialogContent className="min-h-80">
            <DialogHeader>
              <DialogTitle>Task model</DialogTitle>
              <DialogDescription>Choose a model for the selected task.</DialogDescription>
            </DialogHeader>
            <div data-testid="review-picker-dialog">
              <ModelPicker
                value={model || undefined}
                candidates={candidates}
                onPick={setModel}
                placeholder="Choose dialog model"
              />
            </div>
          </DialogContent>
        </Dialog>
        <div className="border p-3" data-testid="review-picker-control">
          <ModelPicker
            value={model || undefined}
            candidates={candidates}
            onPick={setModel}
            placeholder="Choose review model"
          />
        </div>
        <div className="h-40 overflow-auto border p-3" data-testid="review-picker-clipped">
          <p className="mb-4 text-sm">
            Model selection inside a scrollable task or settings panel.
          </p>
          <ModelPicker
            value={model || undefined}
            candidates={candidates}
            onPick={setModel}
            placeholder="Choose task model"
          />
        </div>
      </div>
    </div>
  );
}
