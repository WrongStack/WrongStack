import {
  type EnvironmentProfile,
  exportEnvironmentProfile,
  parseEnvironmentProfile,
} from '@wrongstack/webui-protocol';
import { Download, Plus, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { environmentDraft, environmentProfile } from './automation-environment-model';
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
        `Restored unapplied environment edits${savedAt ? ` from ${new Date(savedAt).toLocaleString()}` : ''}.`,
      );
    },
  });
  const close = () => (dirty ? setLeaving(true) : onClose());
  return (
    <Modal title="Automation environment" onClose={close}>
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
            <span className="eyebrow">REUSABLE ENVIRONMENT</span>
            <h2>Prepare the workspace.</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close automation environment"
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        <p>
          Define the copied workspace, setup steps and supporting containers. Applying changes
          updates the job draft; Save automation persists them.
        </p>
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
            <p>
              Unapplied edits were saved from a different version of this environment; it has
              changed since.
            </p>
            <button type="button" className="button secondary" onClick={saved.takeOlder}>
              Use unapplied edits
            </button>
            <button type="button" className="button secondary" onClick={saved.discardOlder}>
              Discard them
            </button>
          </div>
        )}
        <div className="automation-config-grid">
          <label>
            Profile name
            <input
              aria-label="Environment profile name"
              required
              value={draft.name}
              onChange={(event) => change({ ...draft, name: event.target.value })}
            />
          </label>
          <label>
            Workspace image
            <input
              aria-label="Environment workspace image"
              required
              value={draft.image}
              onChange={(event) => change({ ...draft, image: event.target.value })}
            />
          </label>
          <label>
            Setup timeout (seconds)
            <input
              aria-label="Environment setup timeout"
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
          <h3>Setup commands</h3>
          <p>
            One executable command per line. Quotes group arguments; shell expansion is not
            performed.
          </p>
          <textarea
            aria-label="Environment setup commands"
            rows={4}
            value={draft.setup}
            onChange={(event) => change({ ...draft, setup: event.target.value })}
            placeholder={'bun install --frozen-lockfile\nbun run build'}
          />
        </section>
        <section>
          <header>
            <h3>Service containers</h3>
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
              Add service
            </button>
          </header>
          <p>
            Services join the isolated environment network. Health checks must succeed before the
            job starts.
          </p>
          {!draft.services.length && <p className="quiet-state">No supporting services.</p>}
          {draft.services.map((service, index) => (
            <fieldset key={index} aria-label={`Environment service ${index + 1}`}>
              <legend>Service {index + 1}</legend>
              <div className="automation-config-grid">
                {(
                  [
                    ['name', 'Name'],
                    ['image', 'Image'],
                    ['command', 'Startup command (optional)'],
                    ['health', 'Health command'],
                    ['envNames', 'Environment names (comma separated)'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      aria-label={`Service ${index + 1} ${key}`}
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
                aria-label={`Remove environment service ${index + 1}`}
                onClick={() =>
                  change({ ...draft, services: draft.services.filter((_, i) => i !== index) })
                }
              >
                <Trash2 size={13} />
                Remove service
              </button>
            </fieldset>
          ))}
        </section>
        <section>
          <header>
            <h3>Package caches</h3>
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
              Add cache
            </button>
          </header>
          <p>Use /home/node/.bun/install/cache or a named directory under /home/node/.cache/.</p>
          {!draft.caches.length && <p className="quiet-state">No persistent package caches.</p>}
          {draft.caches.map((cache, index) => (
            <fieldset key={index} aria-label={`Environment cache ${index + 1}`}>
              <legend>Cache {index + 1}</legend>
              <div className="automation-config-grid">
                {(['name', 'target'] as const).map((key) => (
                  <label key={key}>
                    {key === 'name' ? 'Name' : 'Container directory'}
                    <input
                      aria-label={`Cache ${index + 1} ${key}`}
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
                aria-label={`Remove environment cache ${index + 1}`}
                onClick={() =>
                  change({ ...draft, caches: draft.caches.filter((_, i) => i !== index) })
                }
              >
                <Trash2 size={13} />
                Remove cache
              </button>
            </fieldset>
          ))}
        </section>
        <section>
          <header>
            <h3>Local preview ports</h3>
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
              Add port
            </button>
          </header>
          <p>
            Ports are published to loopback by the worker. The run receipt reports the assigned host
            ports.
          </p>
          {!draft.ports.length && <p className="quiet-state">No published local ports.</p>}
          {draft.ports.map((port, index) => (
            <fieldset key={index} aria-label={`Environment port ${index + 1}`}>
              <legend>Port {index + 1}</legend>
              <div className="automation-config-grid">
                <label>
                  Name
                  <input
                    aria-label={`Port ${index + 1} name`}
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
                  Container port
                  <input
                    aria-label={`Port ${index + 1} port`}
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
                  Protocol
                  <select
                    aria-label={`Port ${index + 1} protocol`}
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
                aria-label={`Remove environment port ${index + 1}`}
                onClick={() =>
                  change({ ...draft, ports: draft.ports.filter((_, i) => i !== index) })
                }
              >
                <Trash2 size={13} />
                Remove port
              </button>
            </fieldset>
          ))}
        </section>
        <details>
          <summary>Portable environment</summary>
          <p>Import or export the canonical reusable environment document.</p>
          <label className="button secondary feature-import">
            Import environment
            <input
              type="file"
              accept="application/json,.json"
              aria-label="Import environment profile"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file && file.size > 64 * 1024) {
                  setError('Environment profile exceeds 64 KiB.');
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
            Export environment
          </button>
        </details>
        {leaving && (
          <div className="automation-leave" role="alert">
            <p>Discard changes to this environment form?</p>
            <button type="button" className="button secondary" onClick={() => setLeaving(false)}>
              Keep editing environment
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                saved.forget();
                onClose();
              }}
            >
              Discard environment changes
            </button>
          </div>
        )}
        <footer>
          <span>Changes stay in the automation draft until saved.</span>
          <button type="submit" className="button primary">
            Apply environment to draft
          </button>
        </footer>
      </form>
    </Modal>
  );
}
