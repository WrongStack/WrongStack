import { useDesktopText } from './desktop-i18n';
import type { ChatMessage } from './engine-state';
import type { useMessagePins } from './message-pins';

/** Leader-only saved positions, independent of which worker is being inspected. */
export function TranscriptPins({
  messages,
  pins,
  onReveal,
}: {
  messages: readonly ChatMessage[];
  pins: ReturnType<typeof useMessagePins>;
  onReveal: (index: number) => void;
}) {
  const { t } = useDesktopText();
  if (!pins.ids.length) return null;
  return (
    <details className="transcript-pins">
      <summary>{t('messagePins.list', { count: pins.ids.length })}</summary>
      {pins.ids.map((messageId) => {
        const index = messages.findIndex((message) => message.id === messageId);
        return (
          <div key={messageId}>
            <button
              type="button"
              className="button secondary"
              disabled={index < 0}
              onClick={() => onReveal(index)}
            >
              {index < 0 ? t('messagePins.unavailable') : messages[index]?.text.slice(0, 120)}
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => pins.toggle(messageId)}
            >
              {t('messagePins.unpin')}
            </button>
          </div>
        );
      })}
    </details>
  );
}
