import { ExternalLink, ScanSearch, Sparkles } from 'lucide-react';
import { useRef, useState } from 'react';
import { ChatEventCard } from './ChatEventCard';
import { useDesktopText } from './desktop-i18n';
import type { MessageAction } from './message-action';

/** Preparing a review never bypasses the saved composer or submits an agent turn. */
export function ChimeraMessageCard({
  reportId,
  text,
  action,
  onOpen,
}: {
  reportId: string;
  text: string;
  action?: MessageAction | undefined;
  onOpen?: (() => void) | undefined;
}) {
  const { t } = useDesktopText();
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  return (
    <ChatEventCard
      tone="accent"
      className="chat-chimera"
      label={t('chimeraMessage.title')}
      data={{ 'data-chimera-report': reportId }}
      icon={<ScanSearch size={15} />}
      title={t('chimeraMessage.title')}
      meta={<code>{reportId}</code>}
      actions={
        <>
          <button
            type="button"
            className="button secondary small"
            disabled={!onOpen}
            onClick={onOpen}
          >
            <ExternalLink size={12} /> {t('chimeraMessage.open')}
          </button>
          <button
            type="button"
            className="button primary small"
            disabled={!action || 'reason' in action || busy}
            title={action && 'reason' in action ? action.reason : t('chimeraMessage.hint')}
            onClick={async () => {
              if (!action || 'reason' in action || locked.current) return;
              locked.current = true;
              setBusy(true);
              try {
                await action.run();
              } finally {
                locked.current = false;
                setBusy(false);
              }
            }}
          >
            <Sparkles size={12} /> {t('chimeraMessage.prepare')}
          </button>
        </>
      }
    >
      <p>{text}</p>
      {action && 'reason' in action && (
        <p className="chat-event-note" role="status">
          {action.reason}
        </p>
      )}
    </ChatEventCard>
  );
}
