'use client';

import { ExternalLink, KeyRound, LogIn, RefreshCw } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import { clientId } from '../lib/ids';
import { record, rows, text } from '../lib/session';
import type { SessionController } from '../lib/use-session';
import { Modal } from './dialogs';
import { HqBadge, HqImportPanel } from './hq-import';
import { usePresentation } from './presentation-mode';
import { EmptyArtwork } from './vibe-visuals';

interface SavedProvider {
  id: string;
  type: string;
  family: string;
  baseUrl: string;
  models: string[];
  keys: { label: string; masked: string; active: boolean }[];
  hq: boolean;
}
interface Strategy {
  id: string;
  providerId: string;
  label: string;
  description: string;
}
const safeLoginUrl = (value: unknown) => {
  try {
    const url = new URL(text(value));
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
};

export function ProviderManager({
  controller,
  onClose,
}: {
  controller: SessionController;
  onClose: () => void;
}) {
  const { state, connection, send, subscribe } = controller;
  const [saved, setSaved] = useState<SavedProvider[]>([]);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState('saved');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState<Record<string, unknown> | null>(null);
  const [code, setCode] = useState('');
  const [alias, setAlias] = useState('');
  const [query, setQuery] = useState('');
  const activeKind = useRef('');
  const pending = useRef<{
    id: string;
    resolve: (ok: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const refresh = () => {
    send('providers.saved');
    send('providers.list');
    send('auth.oauth.list');
  };
  useEffect(() => {
    const timer = setTimeout(() => {
      setLoaded(true);
      setError('Provider list timed out. Refresh to retry.');
    }, 10_000);
    const off = subscribe((frame) => {
      const p = record(frame.payload);
      if (frame.type === 'providers.saved') {
        clearTimeout(timer);
        setLoaded(true);
        setSaved(
          rows(p.providers)
            .filter((v) => text(v.id))
            .map((v) => ({
              id: text(v.id),
              type: text(v.type),
              family: text(v.family),
              baseUrl: text(v.baseUrl),
              models: Array.isArray(v.models)
                ? v.models.filter((m): m is string => typeof m === 'string')
                : [],
              hq: text(record(v.hq).profileId) !== '',
              keys: rows(v.apiKeys).map((k) => ({
                label: text(k.label),
                masked: text(k.maskedKey),
                active: k.isActive === true,
              })),
            })),
        );
      }
      if (frame.type === 'auth.oauth.providers')
        setStrategies(
          rows(p.providers)
            .filter((v) => text(v.id))
            .map((v) => ({
              id: text(v.id),
              providerId: text(v.providerId),
              label: text(v.label),
              description: text(v.description),
            })),
        );
      if (
        frame.type === 'key.operation_result' &&
        pending.current &&
        pending.current.id === p.requestId
      ) {
        const request = pending.current;
        pending.current = null;
        clearTimeout(request.timer);
        setBusy(false);
        if (p.success === true) {
          setStatus(text(p.message) || 'Saved.');
          setError('');
          send('providers.saved');
          send('providers.list');
        } else setError(text(p.message) || 'The operation failed.');
        request.resolve(p.success === true);
      }
      if (frame.type === 'auth.oauth.status' && p.kind === activeKind.current) {
        if (p.phase === 'success' || p.phase === 'error' || p.phase === 'cancelled') {
          activeKind.current = '';
          setLogin(null);
          setCode('');
          if (p.phase === 'success') {
            setStatus(text(p.message) || 'Signed in.');
            setTab('saved');
            send('providers.saved');
            send('providers.list');
          } else if (p.phase === 'error') setError(text(p.message) || 'Sign-in failed.');
        } else setLogin((previous) => ({ ...previous, ...p }));
      }
    });
    send('providers.saved');
    send('providers.list');
    send('auth.oauth.list');
    return () => {
      off();
      clearTimeout(timer);
      if (activeKind.current) send('auth.oauth.cancel', { kind: activeKind.current });
      if (pending.current) {
        clearTimeout(pending.current.timer);
        pending.current.resolve(false);
        pending.current = null;
      }
    };
  }, [send, subscribe]);
  const mutate = (type: string, payload: Record<string, unknown>): Promise<boolean> => {
    if (pending.current || activeKind.current || connection !== 'open')
      return Promise.resolve(false);
    const requestId = clientId();
    setBusy(true);
    setError('');
    setStatus('Saving…');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.current = null;
        setBusy(false);
        setStatus('');
        setError('The server did not confirm this change. Refresh before retrying.');
        resolve(false);
      }, 15_000);
      pending.current = { id: requestId, resolve, timer };
      if (!send(type, { ...payload, requestId })) {
        clearTimeout(timer);
        pending.current = null;
        setBusy(false);
        setError('Reconnect to manage providers.');
        resolve(false);
      }
    });
  };
  const signIn = (strategy: Strategy, existing?: string) => {
    if (activeKind.current || busy || connection !== 'open') return;
    let id = existing || alias.trim() || strategy.providerId;
    if (!existing && !alias.trim()) {
      let n = 2;
      while (saved.some((p) => p.id === id)) id = `${strategy.providerId}-${n++}`;
    }
    if (!existing && saved.some((p) => p.id === id)) {
      setError(
        'That alias already exists. Use its Sign in button to reconnect it, or choose another alias.',
      );
      return;
    }
    setError('');
    setStatus('');
    setCode('');
    activeKind.current = strategy.id;
    setLogin({ kind: strategy.id, phase: 'starting', providerId: id });
    if (!send('auth.oauth.start', { kind: strategy.id, providerId: id })) {
      activeKind.current = '';
      setLogin(null);
      setError('Reconnect to sign in.');
    }
  };
  const disabled = busy || Boolean(login) || connection !== 'open';
  const loginUrl = safeLoginUrl(login?.authorizeUrl || login?.verificationUri);
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Providers & accounts"
      detailToggle
      icon={<KeyRound size={20} />}
      description="Manage saved credentials, subscription sign-ins and custom model endpoints."
      wide
    >
      <div className="provider-toolbar">
        <span>{saved.length} saved providers</span>
        <button type="button" className="secondary-button" disabled={disabled} onClick={refresh}>
          <RefreshCw size={14} />
          Refresh providers
        </button>
      </div>
      {connection !== 'open' && <p role="status">Reconnect to manage providers.</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="fine-print" role="status">
          {status}
        </p>
      )}
      {login && (
        <section className="oauth-progress" aria-label="Sign-in progress">
          <strong>
            {text(login.providerId)} · {text(login.phase).replaceAll('_', ' ')}
          </strong>
          <p>
            {text(login.message) ||
              'Complete authorization with the provider. Credentials are stored by the backend.'}
          </p>
          {text(login.userCode) && <code>{text(login.userCode)}</code>}
          {loginUrl && (
            <a href={loginUrl} target="_blank" rel="noopener noreferrer">
              Open sign-in page <ExternalLink size={13} />
            </a>
          )}
          {login.phase === 'awaiting_browser' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send('auth.oauth.code', { kind: activeKind.current, input: code.trim() });
              }}
            >
              <label>
                Redirect URL or authorization code
                <input
                  aria-label="Authorization code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <button
                type="submit"
                className="secondary-button"
                disabled={!code.trim() || connection !== 'open'}
              >
                Submit code
              </button>
            </form>
          )}
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              send('auth.oauth.cancel', { kind: activeKind.current });
              activeKind.current = '';
              setLogin(null);
              setCode('');
            }}
          >
            Cancel sign-in
          </button>
        </section>
      )}
      <Tabs.Root value={tab} onValueChange={setTab} className="provider-tabs">
        <Tabs.List className="diff-tabs" aria-label="Provider management">
          <Tabs.Trigger value="saved">Accounts</Tabs.Trigger>
          <Tabs.Trigger value="key">API key</Tabs.Trigger>
          <Tabs.Trigger value="oauth">Subscription login</Tabs.Trigger>
          <Tabs.Trigger value="custom">Custom endpoint</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="saved">
          <input
            className="context-search"
            aria-label="Search saved providers"
            placeholder="Search accounts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {!loaded && <p role="status">Loading saved providers…</p>}
          {loaded && !saved.length && (
            <div className="provider-empty">
              <EmptyArtwork kind="providers" />
              <h3>Connect your first provider</h3>
              <p className="panel-hint">
                No accounts yet. Add an API key, sign in with a subscription, or connect a local
                endpoint.
              </p>
            </div>
          )}
          {loaded &&
            saved.length > 0 &&
            !saved.some((provider) =>
              `${provider.id} ${provider.type}`.toLowerCase().includes(query.toLowerCase()),
            ) && (
              <p className="panel-hint" role="status">
                No accounts match “{query}”. Try another name.
              </p>
            )}
          <HqImportPanel controller={controller} />
          <div className="provider-cards">
            {saved
              .filter((p) => `${p.id} ${p.type}`.toLowerCase().includes(query.toLowerCase()))
              .map((provider) => (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  current={provider.id === state.provider}
                  disabled={disabled}
                  mutate={mutate}
                  strategy={strategies.find(
                    (s) => s.providerId === provider.type || s.providerId === provider.id,
                  )}
                  signIn={signIn}
                />
              ))}
          </div>
        </Tabs.Content>
        <Tabs.Content value="key">
          <ProviderForm
            key="catalog"
            controller={controller}
            saved={saved}
            disabled={disabled}
            mutate={mutate}
            onSaved={() => setTab('saved')}
          />
        </Tabs.Content>
        <Tabs.Content value="custom">
          <ProviderForm
            key="custom"
            custom
            controller={controller}
            saved={saved}
            disabled={disabled}
            mutate={mutate}
            onSaved={() => setTab('saved')}
          />
        </Tabs.Content>
        <Tabs.Content value="oauth">
          <p className="panel-hint">
            Use an existing subscription, including OpenAI / ChatGPT when offered by this backend.
          </p>
          <label className="provider-form">
            Account alias (optional)
            <input
              aria-label="Account alias"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="A unique name for this account"
            />
          </label>
          <div className="provider-cards">
            {strategies.map((strategy) => (
              <article key={strategy.id}>
                <div>
                  <strong>{strategy.label}</strong>
                  <p>{strategy.description}</p>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={disabled || !loaded}
                  onClick={() => signIn(strategy)}
                >
                  <LogIn size={14} />
                  Sign in to {strategy.label}
                </button>
              </article>
            ))}
          </div>
          {!strategies.length && (
            <p className="panel-hint">
              No subscription sign-in methods have been reported. Refresh to retry.
            </p>
          )}
        </Tabs.Content>
      </Tabs.Root>
      <p className="fine-print">
        Keys and OAuth tokens stay in the backend credential vault. Only masked keys are displayed
        here.
      </p>
    </Modal>
  );
}

type Mutate = (type: string, payload: Record<string, unknown>) => Promise<boolean>;
function ProviderCard({
  provider,
  current,
  disabled,
  mutate,
  strategy,
  signIn,
}: {
  provider: SavedProvider;
  current: boolean;
  disabled: boolean;
  mutate: Mutate;
  strategy?: Strategy;
  signIn: (strategy: Strategy, alias: string) => void;
}) {
  const [remove, setRemove] = useState<
    { kind: 'provider' } | { kind: 'key'; label: string } | null
  >(null);
  const [addingKey, setAddingKey] = useState(false);
  const { mode } = usePresentation();
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  return (
    <article className="provider-account" data-current={current || undefined}>
      <header>
        <div className="provider-identity">
          <span className="provider-avatar" aria-hidden="true">
            {provider.id.slice(0, 2).toUpperCase()}
          </span>
          <div>
            <strong>
              {provider.id}
              <HqBadge hq={provider.hq} />
            </strong>
            <small>
              {provider.type || provider.family}
              {current && ' · Current model provider'}
            </small>
          </div>
        </div>
        <div>
          {strategy && (
            <button
              type="button"
              className="secondary-button"
              disabled={disabled}
              onClick={() => signIn(strategy, provider.id)}
            >
              <LogIn size={14} />
              Sign in
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || current}
            title={
              current
                ? 'Switch models before removing the current provider'
                : 'Remove saved provider'
            }
            onClick={() => setRemove({ kind: 'provider' })}
          >
            Remove
          </button>
        </div>
      </header>
      <p className="provider-endpoint" hidden={mode !== 'extended'}>
        {provider.baseUrl || 'Subscription / managed endpoint'} · {provider.models.length}{' '}
        configured models
      </p>
      {provider.keys.map((key) => (
        <div className="provider-key" key={key.label}>
          <span>
            <strong>{key.label}</strong>
            <code>{key.masked}</code>
          </span>
          <small>{key.active ? 'Active' : ''}</small>
          {!key.active && (
            <button
              type="button"
              className="secondary-button"
              disabled={disabled}
              onClick={() =>
                void mutate('key.set_active', { providerId: provider.id, label: key.label })
              }
            >
              Use key
            </button>
          )}
          <button
            type="button"
            className="secondary-button danger-button"
            disabled={disabled}
            aria-label={`Delete key ${key.label} from ${provider.id}`}
            onClick={() => setRemove({ kind: 'key', label: key.label })}
          >
            Delete
          </button>
        </div>
      ))}
      <button
        type="button"
        className="secondary-button"
        disabled={disabled}
        onClick={() => {
          setAddingKey((v) => !v);
          setSecret('');
        }}
      >
        <KeyRound size={13} />
        Add key
      </button>
      {addingKey && (
        <form
          className="provider-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await mutate('key.add', {
                providerId: provider.id,
                label: label.trim(),
                apiKey: secret.trim(),
              })
            ) {
              setSecret('');
              setLabel('');
              setAddingKey(false);
            }
          }}
        >
          <label>
            Key label
            <input value={label} onChange={(e) => setLabel(e.target.value)} required />
          </label>
          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              required
            />
          </label>
          <button
            type="submit"
            className="primary-button"
            disabled={disabled || !label.trim() || !secret.trim()}
          >
            Save key
          </button>
        </form>
      )}
      {remove !== null && (
        <fieldset className="provider-remove" aria-label="Confirm removal">
          <p>
            {remove.kind === 'provider'
              ? `Remove ${provider.id} and its saved credentials?`
              : `Delete key “${remove.label}” from ${provider.id}?`}
          </p>
          <button
            type="button"
            className="secondary-button"
            disabled={disabled}
            onClick={() => setRemove(null)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="secondary-button danger-button"
            disabled={disabled}
            onClick={async () => {
              if (
                await mutate(remove.kind === 'provider' ? 'provider.remove' : 'key.delete', {
                  providerId: provider.id,
                  ...(remove.kind !== 'provider' ? { label: remove.label } : {}),
                })
              )
                setRemove(null);
            }}
          >
            Confirm removal
          </button>
        </fieldset>
      )}
    </article>
  );
}

function ProviderForm({
  custom = false,
  controller,
  saved,
  disabled,
  mutate,
  onSaved,
}: {
  custom?: boolean;
  controller: SessionController;
  saved: SavedProvider[];
  disabled: boolean;
  mutate: Mutate;
  onSaved: () => void;
}) {
  const [providerId, setProviderId] = useState('');
  const [alias, setAlias] = useState('');
  const [secret, setSecret] = useState('');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:11434/v1');
  const [family, setFamily] = useState('openai-compatible');
  const [models, setModels] = useState('');
  const selected = controller.state.providers.find((p) => p.id === providerId);
  const id = alias.trim() || (custom ? '' : providerId);
  const taken = saved.some((p) => p.id === id);
  return (
    <form
      className="provider-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!id || taken || (!custom && !selected)) return;
        const ok = await mutate('provider.add', {
          id,
          ...(!custom && selected
            ? { type: selected.id, family: selected.family, baseUrl: selected.baseUrl }
            : {
                family,
                baseUrl: baseUrl.trim(),
                models: models
                  .split(',')
                  .map((m) => m.trim())
                  .filter(Boolean),
              }),
          ...(secret.trim() ? { apiKey: secret.trim() } : {}),
        });
        if (ok) {
          setSecret('');
          onSaved();
        }
      }}
    >
      {!custom && (
        <label>
          Provider
          <select
            aria-label="API key provider"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            required
          >
            <option value="">Choose a provider</option>
            {controller.state.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Provider alias
        <input
          aria-label="Provider alias"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          placeholder={custom ? 'my-local-models' : providerId || 'A unique account name'}
          required={custom}
        />
      </label>
      {taken && (
        <p className="form-error">
          This alias already exists. Choose another name or add a key to that account.
        </p>
      )}
      {custom && (
        <>
          <label>
            API family
            <select value={family} onChange={(e) => setFamily(e.target.value)}>
              <option value="openai-compatible">OpenAI compatible</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google</option>
            </select>
          </label>
          <label>
            Base URL
            <input
              type="url"
              aria-label="Provider base URL"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              required
            />
          </label>
          <label>
            Model IDs
            <input
              aria-label="Provider model IDs"
              value={models}
              onChange={(e) => setModels(e.target.value)}
              placeholder="llama3.2, qwen3"
            />
          </label>
        </>
      )}
      <label>
        {custom ? 'API key (optional for local servers)' : 'API key'}
        <input
          aria-label={custom ? 'Optional API key' : 'New provider API key'}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          required={!custom}
        />
      </label>
      <button
        type="submit"
        className="primary-button"
        disabled={disabled || !id || taken || (!custom && (!selected || !secret.trim()))}
      >
        Save provider
      </button>
    </form>
  );
}
