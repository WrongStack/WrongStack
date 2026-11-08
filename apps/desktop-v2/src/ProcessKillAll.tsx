import { Square } from 'lucide-react';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { Modal } from './Modal';

/**
 * Terminates every process this conversation's engine tracks, after a confirmation that names how
 * many are running, as the WebUI's process monitor does. The request is scoped to the session, so
 * other conversations' commands keep running.
 */
export function ProcessKillAll({
  sessionId,
  running,
  connected,
  busy,
  command,
  onDone,
}: {
  sessionId: string;
  /** Running processes in this conversation; the action is offered only while some run. */
  running: number;
  connected: boolean;
  /** Another termination is in progress. */
  busy: boolean;
  command: EngineCommand;
  /** Receives the engine's acknowledgement or the failure, then the list is read again. */
  onDone: (result: { ok: boolean; message: string }) => void;
}) {
  const { t } = useDesktopText();
  const [asking, setAsking] = useState(false),
    [pending, setPending] = useState(false);
  if (running <= 0 && !asking) return null;
  const terminate = async () => {
    setPending(true);
    try {
      const reply = await command('process.killAll', { sessionId }, ['key.operation_result']);
      onDone({
        ok: true,
        message: t('processes.killAll.done', {
          message: String(reply['message'] ?? t('processes.acknowledged')),
        }),
      });
      setAsking(false);
    } catch (error) {
      onDone({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="button secondary danger"
        disabled={!connected || busy || pending || running <= 0}
        onClick={() => setAsking(true)}
      >
        <Square size={13} />
        {t('processes.killAll.button')}
      </button>
      {asking && (
        <Modal
          title={t('processes.killAll.title')}
          onClose={() => {
            if (!pending) setAsking(false);
          }}
        >
          <div className="process-review">
            <h2>{t('processes.killAll.ask', { count: running })}</h2>
            <p>{t('processes.killAll.body')}</p>
            <div className="feature-actions">
              <button
                type="button"
                className="button secondary"
                disabled={pending}
                onClick={() => setAsking(false)}
              >
                {t('processes.keepAll')}
              </button>
              <button
                type="button"
                className="button primary danger"
                disabled={pending || !connected || running <= 0}
                onClick={() => void terminate()}
              >
                {pending ? t('processes.requesting') : t('processes.killAll.confirm')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
