import { RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { Session } from './model';
import { NoRecordedSession, reconnectConversation } from './session-reconnect';
import { canReconnect } from './session-reconnect-model';
import './reconnect.css';

/**
 * A way back for a conversation whose engine stopped (the app or its session host restarted,
 * the engine exited, or the user stopped it): reconnecting starts the engine again on this
 * conversation and resumes the session it recorded, so the tab and its history stay.
 */
export function ConversationReconnect({
  session,
  compact = false,
}: {
  session: Session;
  /** A row action in a list instead of the conversation's own notice. */
  compact?: boolean;
}) {
  const { t } = useDesktopText();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  if (!canReconnect(session)) return null;
  const reconnect = async () => {
    setWorking(true);
    setError('');
    try {
      await reconnectConversation(session.id);
    } catch (failure) {
      if (!mounted.current) return;
      setError(
        failure instanceof NoRecordedSession
          ? t('connectionView.noRecord')
          : failure instanceof Error
            ? failure.message
            : String(failure),
      );
    } finally {
      if (mounted.current) setWorking(false);
    }
  };
  const button = (
    <button
      type="button"
      className="button secondary small"
      disabled={working}
      aria-label={
        compact ? t('connectionView.reconnectNamed', { title: session.title }) : undefined
      }
      onClick={() => void reconnect()}
    >
      <RotateCw size={12} />
      {working ? t('connectionView.reconnecting') : t('connectionView.reconnect')}
    </button>
  );
  if (compact)
    return (
      <span className="conversation-reconnect-action">
        {button}
        {error && <small role="alert">{error}</small>}
      </span>
    );
  return (
    <div className="conversation-reconnect" role="status">
      <p>{t('connectionView.banner')}</p>
      {button}
      {error && (
        <p role="alert" className="conversation-reconnect-error">
          {error}
        </p>
      )}
    </div>
  );
}
