import { X } from 'lucide-react';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { Session } from './model';

/** The WebUI's "Create kit" instruction, with the capability the user describes appended. */
function createKitPrompt(projectRoot: string, capability: string) {
  return `Create a reusable Project Kit capability for this project${projectRoot ? ` (${projectRoot})` : ''}. First discover existing kits with project_kit and prefer extending a suitable one. Use the template contract, add meaningful verification cases, and verify the exact revision. The capability I need is: ${capability.trim()}`;
}

/**
 * Asks a project conversation to create a kit, as the WebUI's "Create kit" does: the instruction
 * goes into the chosen conversation's draft, and sending it stays the user's action there.
 */
export function KitCreateRequest({
  projectRoot,
  sessions,
  onPrepare,
  onNewSession,
  onClose,
}: {
  projectRoot: string;
  sessions: Session[];
  onPrepare: (id: string, text: string) => Promise<boolean>;
  onNewSession: () => void;
  onClose: () => void;
}) {
  const { t } = useDesktopText();
  const agents = sessions.filter((item) => item.kind === 'agent');
  const [capability, setCapability] = useState('');
  const [session, setSession] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const prepare = async () => {
    setBusy(true);
    setNotice('');
    setError('');
    try {
      const ok = await onPrepare(session, createKitPrompt(projectRoot, capability));
      if (ok) setNotice(t('kitCreate.added'));
      else setError(t('projectKit.conflict'));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="kit-request" aria-label={t('kitCreate.label')}>
      <header>
        <h3 className="kit-request-title">{t('kitCreate.title')}</h3>
        <button
          type="button"
          className="icon-button"
          aria-label={t('kitCreate.close')}
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>
      <p>{t('kitCreate.intro')}</p>
      <label className="kit-field">
        {t('kitCreate.capability')}
        <textarea
          rows={3}
          value={capability}
          disabled={busy}
          placeholder={t('kitCreate.placeholder')}
          onChange={(event) => setCapability(event.target.value)}
        />
      </label>
      {agents.length ? (
        <div className="kit-actions">
          <label className="kit-field">
            {t('projectKit.target')}
            <select
              aria-label={t('kitCreate.targetLabel')}
              disabled={busy}
              value={session}
              onChange={(event) => setSession(event.target.value)}
            >
              <option value="">{t('projectKit.chooseConversation')}</option>
              {agents.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} · {item.status}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button primary"
            disabled={busy || !capability.trim() || !agents.some((item) => item.id === session)}
            onClick={() => void prepare()}
          >
            {t('projectKit.addToDraft')}
          </button>
        </div>
      ) : (
        <button type="button" className="button secondary" onClick={onNewSession}>
          {t('projectKit.newConversation')}
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
