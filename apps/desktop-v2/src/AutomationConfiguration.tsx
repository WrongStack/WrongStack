import {
  type AutomationJobInput,
  VERSIONED_AUTOMATION_TEMPLATES,
} from '@wrongstack/webui-protocol';
import { Box, Check, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { Modal } from './Modal';

/** Display keys for the setup requirements the shared templates list in English. */
const REQUIREMENT_KEYS: Record<string, string> = {
  'Trusted runtime image': 'trustedImage',
  'Provider credentials': 'providerCredentials',
  'Project dependency manifest': 'dependencyManifest',
  'Project test command': 'testCommand',
  'GitHub repository and signed event setup': 'githubEvents',
};

export function AutomationTemplates({
  onApply,
  disabled,
}: {
  onApply: (id: string) => void;
  disabled: boolean;
}) {
  const { t } = useDesktopText();
  const [chosen, setChosen] = useState<string | null>(null);
  const template = VERSIONED_AUTOMATION_TEMPLATES.find((item) => item.id === chosen);
  // Names and requirements are display text; the instructions a template applies stay as written.
  const name = (item: { id: string; name: string }) =>
    t(`autoConfig.templateName.${item.id}`, { defaultValue: item.name });
  const requirement = (text: string) =>
    REQUIREMENT_KEYS[text]
      ? t(`autoConfig.requirement.${REQUIREMENT_KEYS[text]}`, { defaultValue: text })
      : text;
  return (
    <section className="automation-templates">
      <header>
        <h3>{t('autoConfig.templatesTitle')}</h3>
        <p>{t('autoConfig.templatesHelp')}</p>
      </header>
      <div>
        {VERSIONED_AUTOMATION_TEMPLATES.map((item) => (
          <button
            type="button"
            disabled={disabled}
            key={item.id}
            onClick={() => setChosen(item.id)}
          >
            <strong>{name(item)}</strong>
            <p>{item.prompt}</p>
            <small>{item.requirements.map(requirement).join(' · ')}</small>
          </button>
        ))}
      </div>
      {template && (
        <Modal title={t('autoConfig.useTemplate')} onClose={() => setChosen(null)}>
          <div className="automation-template-review">
            <h2>{name(template)}</h2>
            <p>{t('autoConfig.templateReplaces')}</p>
            <blockquote>{template.prompt}</blockquote>
            <h3>{t('autoConfig.requiredSetup')}</h3>
            <ul>
              {template.requirements.map((item) => (
                <li key={item}>{requirement(item)}</li>
              ))}
            </ul>
            <button type="button" className="button secondary" onClick={() => setChosen(null)}>
              {t('autoConfig.keepInstructions')}
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => {
                onApply(template.id);
                setChosen(null);
              }}
            >
              {t('autoConfig.applyTemplate')}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function AutomationConfiguration({
  draft,
  update,
  onEditEnvironment,
}: {
  draft: AutomationJobInput;
  update: <K extends keyof AutomationJobInput>(key: K, value: AutomationJobInput[K]) => void;
  onEditEnvironment: () => void;
}) {
  const { t } = useDesktopText();
  const [lastGithub, setLastGithub] = useState(
    draft.github ?? {
      repository: '',
      events: ['issue_comment.created'],
      secretEnv: 'GITHUB_WEBHOOK_SECRET',
    },
  );
  const credentials = draft.credentials ?? [];
  const changeGithub = (next: NonNullable<AutomationJobInput['github']>) => {
    setLastGithub(next);
    update('github', next);
  };
  const environment = draft.environment;
  return (
    <>
      <section className="automation-config-section">
        <header>
          <div>
            <span className="eyebrow">{t('autoConfig.workspaceEyebrow')}</span>
            <h3>
              <Box size={16} />
              {t('autoConfig.environment')}
            </h3>
          </div>
          <button type="button" className="button secondary" onClick={onEditEnvironment}>
            {environment ? t('autoConfig.editEnvironment') : t('autoConfig.configureEnvironment')}
          </button>
        </header>
        {environment ? (
          <>
            <div className="automation-environment-summary">
              <strong>
                {environment.name} <small>v{environment.version}</small>
              </strong>
              <code>{environment.image}</code>
              <div>
                <span>
                  {t('autoConfig.setupSteps', { count: environment.setupCommands.length })}
                </span>
                <span>{t('autoConfig.services', { count: environment.services.length })}</span>
                <span>{t('autoConfig.caches', { count: environment.caches.length })}</span>
                <span>{t('autoConfig.ports', { count: environment.ports.length })}</span>
              </div>
            </div>
            <p>{t('autoConfig.deadline', { count: environment.setupTimeoutMs / 1000 })}</p>
            {environment.services.length > 0 && (
              <ul>
                {environment.services.map((service) => (
                  <li key={service.name}>
                    {service.name} · {service.image} · {t('autoConfig.health')}{' '}
                    <code>{service.healthCommand.join(' ')}</code>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="text-link"
              onClick={() => update('environment', undefined)}
            >
              {t('autoConfig.removeEnvironment')}
            </button>
          </>
        ) : (
          <p>{t('autoConfig.noEnvironment')}</p>
        )}
      </section>
      <section className="automation-config-section">
        <header>
          <div>
            <span className="eyebrow">{t('autoConfig.referencesEyebrow')}</span>
            <h3>
              <KeyRound size={16} />
              {t('autoConfig.credentials')}
            </h3>
          </div>
          <button
            type="button"
            className="button secondary"
            disabled={credentials.length >= 16}
            onClick={() =>
              update('credentials', [
                ...credentials,
                { envName: '', profile: 'default', provider: '', keyLabel: '' },
              ])
            }
          >
            <Plus size={13} />
            {t('autoConfig.addCredential')}
          </button>
        </header>
        <p>{t('autoConfig.credentialsHelp')}</p>
        {!credentials.length && <p className="quiet-state">{t('autoConfig.noCredentials')}</p>}
        {credentials.map((ref, index) => (
          <fieldset
            key={index}
            className="automation-credential-row"
            aria-label={t('autoConfig.credentialGroup', { n: index + 1 })}
          >
            <legend>{t('autoConfig.credential', { n: index + 1 })}</legend>
            <div className="automation-config-grid">
              {(['envName', 'profile', 'provider', 'keyLabel'] as const).map((key) => (
                <label key={key}>
                  {t(`autoConfig.field.${key}`)}
                  <input
                    aria-label={t('autoConfig.credentialField', { n: index + 1, field: key })}
                    required
                    value={ref[key]}
                    onChange={(event) =>
                      update(
                        'credentials',
                        credentials.map((item, i) =>
                          i === index ? { ...item, [key]: event.target.value } : item,
                        ),
                      )
                    }
                    placeholder={key === 'envName' ? 'OPENAI_API_KEY' : undefined}
                  />
                </label>
              ))}
            </div>
            <button
              type="button"
              className="text-link"
              aria-label={t('autoConfig.removeCredential', { n: index + 1 })}
              onClick={() =>
                update(
                  'credentials',
                  credentials.filter((_, i) => i !== index),
                )
              }
            >
              <Trash2 size={13} />
              {t('autoConfig.removeReference')}
            </button>
          </fieldset>
        ))}
      </section>
      <section className="automation-config-section">
        <header>
          <div>
            <span className="eyebrow">{t('autoConfig.triggerEyebrow')}</span>
            <h3>{t('autoConfig.githubEvents')}</h3>
          </div>
          <label className="feature-checkbox">
            <input
              aria-label={t('autoConfig.useGithub')}
              type="checkbox"
              checked={!!draft.github}
              onChange={(event) => {
                if (!event.target.checked && draft.github) setLastGithub(draft.github);
                update('github', event.target.checked ? lastGithub : undefined);
              }}
            />
            {t('autoConfig.configureGithub')}
          </label>
        </header>
        {draft.github ? (
          <>
            <p>{t('autoConfig.githubHelp')}</p>
            <div className="automation-config-grid">
              <label>
                {t('autoConfig.repository')}
                <input
                  aria-label={t('autoConfig.repositoryLabel')}
                  required
                  placeholder="owner/repository"
                  value={draft.github.repository}
                  onChange={(event) =>
                    changeGithub({ ...draft.github!, repository: event.target.value })
                  }
                />
              </label>
              <label>
                {t('autoConfig.eventNames')}
                <input
                  aria-label={t('autoConfig.eventNamesLabel')}
                  required
                  placeholder="issue_comment.created, pull_request.opened"
                  value={draft.github.events.join(', ')}
                  onChange={(event) =>
                    changeGithub({
                      ...draft.github!,
                      events: event.target.value.split(',').map((value) => value.trim()),
                    })
                  }
                />
              </label>
              <label>
                {t('autoConfig.secretName')}
                <input
                  aria-label={t('autoConfig.secretNameLabel')}
                  required
                  value={draft.github.secretEnv}
                  onChange={(event) =>
                    changeGithub({ ...draft.github!, secretEnv: event.target.value })
                  }
                />
              </label>
            </div>
            <details>
              <summary>{t('autoConfig.filters')}</summary>
              <div className="automation-config-grid">
                {(['mention', 'label', 'branch', 'conclusion'] as const).map((key) => (
                  <label key={key}>
                    {t(`autoConfig.filter.${key}`)}
                    <input
                      aria-label={t('autoConfig.filterLabel', { key })}
                      value={draft.github!.filters?.[key] ?? ''}
                      onChange={(event) =>
                        changeGithub({
                          ...draft.github!,
                          filters: {
                            ...draft.github!.filters,
                            [key]: event.target.value || undefined,
                          },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <label className="feature-checkbox">
                <input
                  aria-label={t('autoConfig.excludeBotsLabel')}
                  type="checkbox"
                  checked={draft.github.filters?.excludeBots ?? false}
                  onChange={(event) =>
                    changeGithub({
                      ...draft.github!,
                      filters: { ...draft.github!.filters, excludeBots: event.target.checked },
                    })
                  }
                />
                {t('autoConfig.excludeBots')}
              </label>
              <label>
                {t('autoConfig.draftStatus')}
                <select
                  aria-label={t('autoConfig.draftStatusLabel')}
                  value={
                    draft.github.filters?.draft === undefined
                      ? 'any'
                      : String(draft.github.filters.draft)
                  }
                  onChange={(event) =>
                    changeGithub({
                      ...draft.github!,
                      filters: {
                        ...draft.github!.filters,
                        draft:
                          event.target.value === 'any' ? undefined : event.target.value === 'true',
                      },
                    })
                  }
                >
                  <option value="any">{t('autoConfig.anyStatus')}</option>
                  <option value="false">{t('autoConfig.readyForReview')}</option>
                  <option value="true">{t('autoConfig.draftOnly')}</option>
                </select>
              </label>
            </details>
            <p className="automation-reference-note">
              <Check size={13} />
              {t('autoConfig.noWebhook')}
            </p>
          </>
        ) : (
          <p>{t('autoConfig.noGithub')}</p>
        )}
      </section>
    </>
  );
}
