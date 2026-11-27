import { ListChecks } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import './fleet-policy.css';
import { journalTail, projectRequest } from './journal-tail';

const COMPANION_STATUS = 'kanban.companion.status';

/**
 * The confirmed switch in a `kanban.companion.status` reply: true or false, or null when the
 * reply does not confirm a value (a failure reply carries its reason in `error`, no `data`).
 */
export function companionEnabled(status: Record<string, unknown>): boolean | null {
  if (status['success'] !== true) return null;
  const data =
    typeof status['data'] === 'object' && status['data'] !== null
      ? (status['data'] as Record<string, unknown>)
      : undefined;
  return typeof data?.['enabled'] === 'boolean' ? data['enabled'] : null;
}

/**
 * The project-wide Kanban Companion switch in Fleet settings. Unlike the profile companions
 * beside it, it is not part of the settings draft: it asks this project's Kanban host
 * (`kanban.companion.get` / `kanban.companion.set`, replies correlated by requestId on the
 * project's journal tail) and shows only what the server confirms, converging on the host's
 * request-less `kanban.companion.status` broadcasts while the settings are open. The strings
 * fall back to English until `kanbanCompanion.*` lands in the desktop catalogs.
 */
export function KanbanCompanionSettings({ projectId }: { projectId: string }) {
  const { t } = useDesktopText();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A late reply from a project the operator already left must not land on the new one.
  const current = useRef('');
  current.current = projectId;

  const ask = useCallback(
    (value?: boolean) =>
      projectRequest(
        projectId,
        value === undefined ? 'kanban.companion.get' : 'kanban.companion.set',
        value === undefined ? {} : { enabled: value },
        [COMPANION_STATUS],
      ),
    [projectId],
  );
  const read = useCallback(() => {
    setError('');
    void ask()
      .then((status) => {
        if (current.current === projectId) setEnabled(companionEnabled(status));
      })
      .catch((cause: unknown) => {
        if (current.current === projectId)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [ask, projectId]);

  // The confirmed value now, then the host's broadcasts while this page is open.
  useEffect(() => {
    setEnabled(null);
    setError('');
    if (!projectId) return;
    read();
    return journalTail(projectId).listen((event) => {
      if (event.type !== COMPANION_STATUS || typeof event.payload['requestId'] === 'string') return;
      if (current.current !== projectId) return;
      setEnabled(companionEnabled(event.payload));
    });
  }, [projectId, read]);

  const switchCompanion = (next: boolean) => {
    if (busy) return;
    setBusy(true);
    setError('');
    void ask(next)
      .then((status) => {
        const confirmed = companionEnabled(status);
        if (current.current === projectId && confirmed !== null) {
          setEnabled(confirmed);
          return;
        }
        throw new Error(
          t('kanbanCompanion.unconfirmed', {
            defaultValue: 'The project engine did not confirm the switch. Try again.',
          }),
        );
      })
      .catch((cause: unknown) => {
        if (current.current === projectId)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (current.current === projectId) setBusy(false);
      });
  };

  return (
    <section
      className="fleet-companions"
      aria-label={t('kanbanCompanion.label', { defaultValue: 'Kanban Companion (project-wide)' })}
    >
      <header>
        <div>
          <span className="eyebrow">
            {t('kanbanCompanion.eyebrow', { defaultValue: 'PROJECT-WIDE' })}
          </span>
          <h3>{t('kanbanCompanion.title', { defaultValue: 'Kanban Companion' })}</h3>
        </div>
        <p>
          {t('kanbanCompanion.intro', {
            defaultValue:
              'One switch for this whole project, not your profile. The companion routes incoming requirements onto the board, helps dispatch the next task, and keeps the board clean.',
          })}
        </p>
      </header>
      <label className="fleet-policy-switch">
        <ListChecks size={19} aria-hidden="true" />
        <span>
          <strong>
            {t('kanbanCompanion.switchTitle', { defaultValue: 'Enable the Kanban Companion' })}
          </strong>
          <small>
            {t('kanbanCompanion.switchHelp', {
              defaultValue:
                "Applies to every session in this project immediately; it is saved on the project's Kanban host, not in these settings.",
            })}
          </small>
          <em>
            {!projectId
              ? t('kanbanCompanion.noProject', {
                  defaultValue: 'Open a project to manage its Kanban Companion.',
                })
              : enabled === null
                ? t('kanbanCompanion.unreported', {
                    defaultValue: 'Not confirmed by the project engine yet',
                  })
                : enabled
                  ? t('kanbanCompanion.on', { defaultValue: 'Enabled for this project' })
                  : t('kanbanCompanion.off', { defaultValue: 'Disabled for this project' })}
          </em>
        </span>
        <input
          type="checkbox"
          aria-label={t('kanbanCompanion.switchTitle', {
            defaultValue: 'Enable the Kanban Companion',
          })}
          disabled={!projectId || busy || enabled === null}
          checked={enabled === true}
          onChange={(event) => switchCompanion(event.target.checked)}
        />
      </label>
      {error && (
        <div className="session-error settings-feedback-error" role="alert">
          <span>{error}</span>
          <button type="button" className="button secondary small" disabled={busy} onClick={read}>
            {t('kanbanCompanion.retry', { defaultValue: 'Try again' })}
          </button>
        </div>
      )}
    </section>
  );
}
