import { ChevronDown, ListPlus, Pencil, X } from 'lucide-react';
import type { Ref } from 'react';
import { splitReferenceMessage } from './composer-resources-model';
import type { EngineState } from './engine-state';

type QueuedPrompt = EngineState['queue'][number];

/** The engine-owned prompt queue shown above the composer while a turn is running. */
export function ComposerQueue({
  queue,
  panel,
  busy,
  connected,
  sending,
  onAction,
  onCopy,
}: {
  queue: readonly QueuedPrompt[];
  panel: Ref<HTMLDetailsElement>;
  busy: boolean;
  connected: boolean;
  sending: boolean;
  onAction: (type: string, payload?: Record<string, unknown>) => void;
  onCopy: (text: string) => void;
}) {
  if (queue.length === 0) return null;
  return (
    <details className="composer-queue" ref={panel}>
      <summary>
        <ListPlus size={14} /> {queue.length} queued {queue.length === 1 ? 'prompt' : 'prompts'}
        <small>Engine-owned · runs after this turn</small>
        <ChevronDown size={13} />
      </summary>
      <div className="composer-queue-heading">
        <span>Pending prompts</span>
        <button type="button" disabled={busy || !connected} onClick={() => onAction('queue.clear')}>
          Clear queue
        </button>
      </div>
      <ol>
        {queue.map((item) => {
          const view = splitReferenceMessage(item.text);
          return (
            <li key={item.id}>
              <p>
                {view.text || 'Project file references'}
                {view.paths.length > 0 && <small> · {view.paths.length} referenced files</small>}
                {item.imageCount > 0 && <small> · {item.imageCount} attachments</small>}
              </p>
              <div>
                <button
                  type="button"
                  title="Copy queued text into the composer; the original stays queued"
                  disabled={sending}
                  onClick={() => onCopy(item.text)}
                >
                  <Pencil size={13} /> {item.imageCount > 0 ? 'Copy text only' : 'Copy to draft'}
                </button>
                <button
                  type="button"
                  aria-label={`Remove queued prompt ${item.text}`}
                  disabled={busy || !connected}
                  onClick={() => onAction('queue.remove', { id: item.id })}
                >
                  <X size={13} />
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
