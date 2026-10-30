import { PromptLibraryModal } from '@/components/PromptLibraryModal';
import type { PromptMeta } from '@/components/prompt-library-model';
import { Button } from '@/components/ui/button';
import { getWSClient } from '@/lib/ws-client';
import { useUIStore } from '@/stores';

const longName = 'Workspace_review_evidence_'.repeat(6);
const prompts: PromptMeta[] = [
  {
    id: 'prompt-control',
    slug: 'workspace-review',
    title: 'Review workspace',
    description: 'Inspect the workspace and record evidence.',
    category: 'review',
    tags: ['review'],
    source: 'user',
    favorite: false,
    variables: [],
  },
  {
    id: 'prompt-long',
    slug: 'workspace-review-long',
    title: longName,
    description: `https://example.test/${'evidence_'.repeat(18)}`,
    category: 'review',
    tags: ['review'],
    source: 'user',
    favorite: false,
    variables: [{ name: 'workspace', description: 'Project to inspect', required: true }],
  },
];

/** Only the WebSocket boundary is replaced; the dialog and stores are production code. */
export function seedPromptReview() {
  const sent: unknown[] = [];
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
  client.send = ((message: { type: string; payload?: { slug?: string; requestId?: string } }) => {
    sent.push(message);
    const reply = (type: string, payload: unknown) =>
      queueMicrotask(() => {
        for (const handler of handlers.get(type) ?? []) handler({ type, payload });
      });
    if (message.type === 'prompts.list') {
      reply(message.type, {
        prompts,
        categories: [{ id: 'review', label: 'Workspace review', count: prompts.length }],
      });
    }
    if (message.type === 'prompts.content') {
      reply(message.type, {
        slug: message.payload?.slug,
        requestId: message.payload?.requestId,
        found: true,
        content: 'Review {{workspace}} and report the result.',
        variants: {
          simple: 'Review {{workspace}}.',
          detailed: 'Review {{workspace}} and report the result.',
          advanced: 'Review {{workspace}} and record reproducible evidence.',
        },
      });
    }
    if (message.type === 'prompts.create') {
      reply('prompts.created', { success: true, slug: 'new-review' });
    }
    return true;
  }) as typeof client.send;
  return { promptMessages: sent };
}

export function PromptReviewWorkbench() {
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4" data-testid="prompt-review">
      <Button onClick={() => useUIStore.getState().setPromptLibraryOpen(true)}>
        Open prompt library
      </Button>
      <textarea aria-label="Review message" className="block w-full border bg-background p-2" />
      <PromptLibraryModal />
    </div>
  );
}
