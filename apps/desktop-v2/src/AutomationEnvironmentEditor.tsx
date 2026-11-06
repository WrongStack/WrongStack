import {
  type EnvironmentProfile,
  exportEnvironmentProfile,
  parseEnvironmentProfile,
} from '@wrongstack/webui-protocol';
import { Download, Plus, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { environmentDraft, environmentProfile } from './automation-environment-model';
import { useDesktopText } from './desktop-i18n';
import { displayDateTime } from './display-dates';
import { Modal } from './Modal';
import { useEnvironmentDraft } from './useEnvironmentDraft';

export function AutomationEnvironmentEditor({
  value,
  image,
  onApply,
  onClose,
  projectId,
  jobId,
}: {
  value?: EnvironmentProfile;
  image: string;
  onApply: (profile: EnvironmentProfile) => void;
  onClose: () => void;
  projectId: string;
  jobId: string | undefined;
}) {
  const { t } = useDesktopText();
  const base = useMemo(() => environmentDraft(value, image), [value, image]);
  const [draft, setDraft] = useState(base);
  const [error, setError] = useState(''),
    [leaving, setLeaving] = useState(false),
    [restored, setRestored] = useState('');
  const change = (next: typeof draft) => {
    setDraft(next);
    setError('');
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const saved = useEnvironmentDraft({
    projectId,
    jobId,
    base,
    draft,
    dirty,
    restore: (next, savedAt) => {
      setDraft(next);
      setRestored(
        savedAt
          ? t('autoEnv.restoredAt', { time: displayDateTime(savedAt) })
          : t('autoEnv.restored'),
      );
    },
  });
  const close = () => (dirty ? setLeaving(true) : onClose());
  return (
    <Modal title={t('autoEnv.title')} onClose={close}>
      <form
        className="automation-environment-editor"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            onApply(environmentProfile(draft));
            saved.forget();
            onClose();
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
          }
        }}
      >
        <header>
          <div>
            <span className="eyebrow">{t('autoEnv.eyebrow')}</span>
            <h2>{t('autoEnv.heading')}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t('autoEnv.close')}
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        <p>{t('autoEnv.intro')}</p>
        {error && (
          <p role="alert" className="session-error">
            {error}
          </p>
        )}
        {restored && (
          <p role="status" className="feature-notice">
            {restored}
          </p>
        )}
        {saved.error && (
          <p role="alert" className="session-error">
            {saved.error}
          </p>
        )}
        {saved.older && (
          <div className="automation-leave" role="alert">
            <p>{t('autoEnv.older')}</p>
            <button type="button" className="button secondary" onClick={saved.takeOlder}>
              {t('autoEnv.useOlder')}
            </button>
            <button type="button" className="button secondary" onClick={saved.discardOlder}>
              {t('autoEnv.discardOlder')}
            </button>
          </div>
        )}
        <div className="automation-config-grid">
          <label>
            {t('autoEnv.profileName')}
            <input
              aria-label={t('autoEnv.profileNameLabel')}
              required
              value={draft.name}
              onChange={(event) => change({ ...draft, name: event.target.value })}
            />
          </label>
          <label>
            {t('autoEnv.image')}
            <input
              aria-label={t('autoEnv.imageLabel')}
              required
              value={draft.image}
              onChange={(event) => change({ ...draft, image: event.target.value })}
            />
          </label>
          <label>
            {t('autoEnv.timeout')}
            <input
              aria-label={t('autoEnv.timeoutLabel')}
              type="number"
              min={1}
              max={3600}
              required
              value={draft.timeoutSeconds}
              onChange={(event) => change({ ...draft, timeoutSeconds: event.target.value })}
            />
          </label>
        </div>
        <section>
          <h3>{t('autoEnv.setup')}</h3>
          <p>{t('autoEnv.setupHelp')}</p>
          <textarea
            aria-label={t('autoEnv.setupLabel')}
            rows={4}
            value={draft.setup}
            onChange={(event) => change({ ...draft, setup: event.target.value })}
            placeholder={'bun install --frozen-lockfile\nbun run build'}
          />
        </section>
        <section>
          <header>
            <h3>{t('autoEnv.services')}</h3>
            <button
              type="button"
              className="button secondary"
              disabled={draft.services.length >= 4}
              onClick={() =>
                change({
                  ...draft,
                  services: [
                    ...draft.services,
                    { name: '', image: '', command: '', health: '', envNames: '' },
                  ],
                })
              }
            >
              <Plus size={14} />
              {t('autoEnv.addService')}
            </button>
          </header>
          <p>{t('autoEnv.servicesHelp')}</p>
          {!draft.services.length && <p className="quiet-state">{t('autoEnv.noServices')}</p>}
          {draft.services.map((service, index) => (
            <fieldset key={index} aria-label={t('autoEnv.serviceGroup', { n: index + 1 })}>
              <legend>{t('autoEnv.service', { n: index + 1 })}</legend>
              <div className="automation-config-grid">
                {(['name', 'image', 'command', 'health', 'envNames'] as const).map((key) => (
                  <label key={key}>
                    {t(`autoEnv.field.${key}`)}
                    <input
                      aria-label={t('autoEnv.serviceField', { n: index + 1, field: key })}
                      value={service[key]}
                      required={key === 'name' || key === 'image' || key === 'health'}
                      onChange={(event) =>
                        change({
                          ...draft,
                          services: draft.services.map((item, i) =>
                            i === index ? { ...item, [key]: event.target.value } : item,
                          ),
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <button
                type="button"
                className="text-link"
                aria-label={t('autoEnv.removeServiceLabel', { n: index + 1 })}
                onClick={() =>
                  change({ ...draft, services: draft.services.filter((_, i) => i !== index) })
                }
              >
                <Trash2 size={13} />
                {t('autoEnv.removeService')}
              </button>
            </fieldset>
          ))}
        </section>
        <section>
          <header>
            <h3>{t('autoEnv.caches')}</h3>
            <button
              type="button"
              className="button secondary"
              disabled={draft.caches.length >= 4}
              onClick={() =>
                change({
                  ...draft,
                  caches: [...draft.caches, { name: '', target: '/home/node/.bun/install/cache' }],
                })
              }
            >
              <Plus size={14} />
              {t('autoEnv.addCache')}
            </button>
          </header>
          <p>{t('autoEnv.cachesHelp')}</p>
          {!draft.caches.length && <p className="quiet-state">{t('autoEnv.noCaches')}</p>}
          {draft.caches.map((cache, index) => (
            <fieldset key={index} aria-label={t('autoEnv.cacheGroup', { n: index + 1 })}>
              <legend>{t('autoEnv.cache', { n: index + 1 })}</legend>
              <div className="automation-config-grid">
                {(['name', 'target'] as const).map((key) => (
                  <label key={key}>
                    {t(`autoEnv.field.${key}`)}
                    <input
                      aria-label={t('autoEnv.cacheField', { n: index + 1, field: key })}
                      required
                      value={cache[key]}
                      onChange={(event) =>
                        change({
                          ...draft,
                          caches: draft.caches.map((item, i) =>
                            i === index ? { ...item, [key]: event.target.value } : item,
                          ),
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <button
                type="button"
                className="text-link"
                aria-label={t('autoEnv.removeCacheLabel', { n: index + 1 })}
                onClick={() =>
                  change({ ...draft, caches: draft.caches.filter((_, i) => i !== index) })
                }
              >
                <Trash2 size={13} />
                {t('autoEnv.removeCache')}
              </button>
            </fieldset>
          ))}
        </section>
        <section>
          <header>
            <h3>{t('autoEnv.ports')}</h3>
            <button
              type="button"
              className="button secondary"
              disabled={draft.ports.length >= 4}
              onClick={() =>
                change({
                  ...draft,
                  ports: [...draft.ports, { name: '', port: '3000', protocol: 'http' }],
                })
              }
            >
              <Plus size={14} />
              {t('autoEnv.addPort')}
            </button>
          </header>
          <p>{t('autoEnv.portsHelp')}</p>
          {!draft.ports.length && <p className="quiet-state">{t('autoEnv.noPorts')}</p>}
          {draft.ports.map((port, index) => (
            <fieldset key={index} aria-label={t('autoEnv.portGroup', { n: index + 1 })}>
              <legend>{t('autoEnv.port', { n: index + 1 })}</legend>
              <div className="automation-config-grid">
                <label>
                  {t('autoEnv.name')}
                  <input
                    aria-label={t('autoEnv.portField', { n: index + 1, field: 'name' })}
                    required
                    value={port.name}
                    onChange={(event) =>
                      change({
                        ...draft,
                        ports: draft.ports.map((item, i) =>
                          i === index ? { ...item, name: event.target.value } : item,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  {t('autoEnv.containerPort')}
                  <input
                    aria-label={t('autoEnv.portField', { n: index + 1, field: 'port' })}
                    type="number"
                    min={1024}
                    max={65535}
                    required
                    value={port.port}
                    onChange={(event) =>
                      change({
                        ...draft,
                        ports: draft.ports.map((item, i) =>
                          i === index ? { ...item, port: event.target.value } : item,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  {t('autoEnv.protocol')}
                  <select
                    aria-label={t('autoEnv.portField', { n: index + 1, field: 'protocol' })}
                    value={port.protocol}
                    onChange={(event) =>
                      change({
                        ...draft,
                        ports: draft.ports.map((item, i) =>
                          i === index
                            ? { ...item, protocol: event.target.value as 'http' | 'tcp' }
                            : item,
                        ),
                      })
                    }
                  >
                    <option value="http">HTTP</option>
                    <option value="tcp">TCP</option>
                  </select>
                </label>
              </div>
              <button
                type="button"
                className="text-link"
                aria-label={t('autoEnv.removePortLabel', { n: index + 1 })}
                onClick={() =>
                  change({ ...draft, ports: draft.ports.filter((_, i) => i !== index) })
                }
              >
                <Trash2 size={13} />
                {t('autoEnv.removePort')}
              </button>
            </fieldset>
          ))}
        </section>
        <details>
          <summary>{t('autoEnv.portable')}</summary>
          <p>{t('autoEnv.portableHelp')}</p>
          <label className="button secondary feature-import">
            {t('autoEnv.import')}
            <input
              type="file"
              accept="application/json,.json"
              aria-label={t('autoEnv.importLabel')}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file && file.size > 64 * 1024) {
                  setError(t('autoEnv.tooLarge'));
                  event.target.value = '';
                  return;
                }
                if (file)
                  void file
                    .text()
                    .then((text) => {
                      change(environmentDraft(parseEnvironmentProfile(text)));
                    })
                    .catch((error) => setError(String(error)));
                event.target.value = '';
              }}
            />
          </label>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              try {
                const document = exportEnvironmentProfile(environmentProfile(draft));
                const link = window.document.createElement('a'),
                  url = URL.createObjectURL(new Blob([document], { type: 'application/json' }));
                link.href = url;
                link.download = `${draft.name}.environment.json`;
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch (error) {
                setError(String(error));
              }
            }}
          >
            <Download size={14} />
            {t('autoEnv.export')}
          </button>
        </details>
        {leaving && (
          <div className="automation-leave" role="alert">
            <p>{t('autoEnv.leaveAsk')}</p>
            <button type="button" className="button secondary" onClick={() => setLeaving(false)}>
              {t('autoEnv.keepEditing')}
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                saved.forget();
                onClose();
              }}
            >
              {t('autoEnv.discard')}
            </button>
          </div>
        )}
        <footer>
          <span>{t('autoEnv.footer')}</span>
          <button type="submit" className="button primary">
            {t('autoEnv.apply')}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
