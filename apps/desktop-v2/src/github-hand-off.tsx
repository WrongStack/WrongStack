import type { GitHubHandOffProps } from '@wrongstack/project-surfaces/github/github-host';
import { createContext, useContext, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { Session } from './model';
import './project-kit.css';

/** The project's conversations and how a prompt reaches one (Project Kit's flow). */
export interface GitHubHandOffTargets {
  sessions: Session[];
  onPrepare: (id: string, text: string) => Promise<boolean>;
  onNewSession: () => void;
}

export const GitHubHandOffContext = createContext<GitHubHandOffTargets | null>(null);

/**
 * Where a GitHub agent prompt goes on the desktop: the user picks one of the
 * project's conversations and the prompt lands in its draft, or creates one.
 * Nothing is chosen for them and nothing is sent.
 */
export function DesktopGitHubHandOff({ prompt, onDone }: GitHubHandOffProps) {
  const { t } = useDesktopText();
  const targets = useContext(GitHubHandOffContext);
  const [session, setSession] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const agents = targets?.sessions.filter((item) => item.kind === 'agent') ?? [];
  if (!targets) return null;
  return (
    <section className="kit-request" aria-label={t('githubPage.targetLabel')}>
      {agents.length ? (
        <div className="kit-actions">
          <label className="kit-field">
            {t('projectKit.target')}
            <select
              aria-label={t('githubPage.targetLabel')}
              disabled={busy}
              value={session}
              onChange={(event) => setSession(event.target.value)}
            >
              <option value="">{t('projectKit.chooseConversation')}</option>
              {agents.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} · {t(`status.${item.status}`, { defaultValue: item.status })}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button primary"
            disabled={busy || !agents.some((item) => item.id === session)}
            onClick={() => {
              setBusy(true);
              setError('');
              void targets
                .onPrepare(session, prompt)
                .then((ok) => (ok ? onDone() : setError(t('projectKit.conflict'))))
                .catch((reason) => setError(String(reason)))
                .finally(() => setBusy(false));
            }}
          >
            {t('projectKit.addToDraft')}
          </button>
        </div>
      ) : (
        <button type="button" className="button secondary" onClick={targets.onNewSession}>
          {t('projectKit.newConversation')}
        </button>
      )}
      <button type="button" className="button secondary" disabled={busy} onClick={onDone}>
        {t('githubPage.cancel')}
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
