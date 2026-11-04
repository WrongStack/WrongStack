import { ChevronDown, ListPlus, Pencil, X } from 'lucide-react';
import type { Ref } from 'react';
import { splitReferenceMessage } from './composer-resources-model';
import { useDesktopText } from './desktop-i18n';
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
  const { t } = useDesktopText();
  if (queue.length === 0) return null;
  return (
    <details className="composer-queue" ref={panel}>
      <summary>
        <ListPlus size={14} />{' '}
        {queue.length === 1
          ? t('composerQueue.one')
          : t('composerQueue.many', { number: queue.length })}
        <small>{t('composerQueue.note')}</small>
        <ChevronDown size={13} />
      </summary>
      <div className="composer-queue-heading">
        <span>{t('composerQueue.pending')}</span>
        <button type="button" disabled={busy || !connected} onClick={() => onAction('queue.clear')}>
          {t('composerQueue.clear')}
        </button>
      </div>
      <ol>
        {queue.map((item) => {
          const view = splitReferenceMessage(item.text);
          return (
            <li key={item.id}>
              <p>
                {view.text || t('composerQueue.references')}
                {view.paths.length > 0 && (
                  <small>
                    {' '}
                    · {t('composerQueue.referencedFiles', { number: view.paths.length })}
                  </small>
                )}
                {item.imageCount > 0 && (
                  <small> · {t('composerQueue.attachments', { number: item.imageCount })}</small>
                )}
              </p>
              <div>
                <button
                  type="button"
                  title={t('composerQueue.copyTitle')}
                  disabled={sending}
                  onClick={() => onCopy(item.text)}
                >
                  <Pencil size={13} />{' '}
                  {item.imageCount > 0
                    ? t('composerQueue.copyTextOnly')
                    : t('composerQueue.copyToDraft')}
                </button>
                <button
                  type="button"
                  aria-label={t('composerQueue.remove', { text: item.text })}
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
