import { useRef, useState } from 'react';
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
    <section aria-label={t('chimeraMessage.title')} data-chimera-report={reportId}>
      <strong>
        {t('chimeraMessage.title')} · {reportId}
      </strong>
      <p>{text}</p>
      <div className="message-actions">
        <button type="button" className="button secondary" disabled={!onOpen} onClick={onOpen}>
          {t('chimeraMessage.open')}
        </button>
        <button
          type="button"
          className="button primary"
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
          {t('chimeraMessage.prepare')}
        </button>
        {action && 'reason' in action && <small role="status">{action.reason}</small>}
      </div>
    </section>
  );
}
