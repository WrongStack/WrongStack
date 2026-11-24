'use client';

/**
 * Add a provider: the models.dev catalog (searched, grouped by wire family,
 * one logo card per provider) or a custom OpenAI-/Anthropic-/Gemini-speaking
 * endpoint. Picking a card opens an inline form — alias (the provider id, then
 * id-2, id-3 …), key name, key — and saves the profile with its first key in
 * one request.
 */
import {
  createVaultProfile,
  type HqVaultProfileMeta,
  type VaultCatalogProvider,
} from '@hq/data/vault-api';
import { Plus, Search, Server } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import {
  baseUrlError,
  catalogGroups,
  configuredCounts,
  familyTitle,
  isSignInOnly,
  nextProfileId,
  parseModelList,
  profileIdError,
  WIRE_FAMILIES,
} from './model';
import { ProviderLogo } from './profile-card';
import { field, label, MessageLine, primaryButton, smallButton, useVaultAction } from './shared';

const GROUP_PREVIEW = 6;

export function CatalogPanel({
  catalog,
  catalogError,
  profiles,
  canWrite,
  onSaved,
  onSignIn,
}: {
  catalog: readonly VaultCatalogProvider[] | null;
  catalogError: string | null;
  profiles: readonly HqVaultProfileMeta[];
  canWrite: boolean;
  onSaved: (id: string) => Promise<void>;
  /** Sign-in-only providers send the operator to the Sign in tab. */
  onSignIn: () => void;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const groups = useMemo(() => catalogGroups(catalog ?? [], query), [catalog, query]);
  const counts = useMemo(() => configuredCounts(profiles), [profiles]);

  return (
    <div className="flex flex-col gap-5" data-testid="vault-catalog">
      <div className="flex flex-col gap-3 border border-border p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex size-10 items-center justify-center border border-border bg-muted/40">
            <Server className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">Custom endpoint</p>
            <p className="text-sm text-muted-foreground">
              A gateway, proxy or self-hosted server (vLLM, LiteLLM, Ollama…). Devices use this
              endpoint as you set it here.
            </p>
          </div>
          {canWrite && open !== '__custom' && (
            <button type="button" className={smallButton} onClick={() => setOpen('__custom')}>
              <Plus className="mr-1 size-3.5" aria-hidden />
              Add custom
            </button>
          )}
        </div>
        {open === '__custom' && (
          <CustomProviderForm
            profiles={profiles}
            onCancel={() => setOpen(null)}
            onSaved={async (id) => {
              setOpen(null);
              await onSaved(id);
            }}
          />
        )}
      </div>

      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          type="search"
          aria-label="Search providers"
          className={cn(field, 'pl-9')}
          placeholder="Search providers — name, id or endpoint"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {catalogError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {catalogError} The custom endpoint form still works.
        </p>
      )}
      {catalog === null && catalogError === null && (
        <p className="text-sm text-muted-foreground">Loading the provider catalog…</p>
      )}
      {catalog !== null && groups.length === 0 && (
        <p className="text-sm text-muted-foreground">No provider matches “{query}”.</p>
      )}

      {groups.map((group) => {
        // Long families stay folded until asked (a search shows everything).
        const capped =
          query.trim() === '' && group.title !== 'Popular' && !expanded.has(group.title);
        const shown = capped
          ? group.providers.filter((p, i) => i < GROUP_PREVIEW || p.id === open)
          : group.providers;
        return (
          <section key={group.title} className="flex flex-col gap-2" aria-label={group.title}>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group.title} <span className="font-normal">· {group.providers.length}</span>
            </h3>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((provider) => (
                <CatalogCard
                  key={provider.id}
                  provider={provider}
                  saved={counts.get(provider.id) ?? 0}
                  open={open === provider.id}
                  canWrite={canWrite}
                  profiles={profiles}
                  onOpen={() => setOpen(provider.id)}
                  onSignIn={onSignIn}
                  onCancel={() => setOpen(null)}
                  onSaved={async (id) => {
                    setOpen(null);
                    await onSaved(id);
                  }}
                />
              ))}
            </div>
            {shown.length < group.providers.length && (
              <button
                type="button"
                className={cn(smallButton, 'self-start')}
                onClick={() => setExpanded(new Set([...expanded, group.title]))}
              >
                Show all {group.providers.length}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

function CatalogCard({
  provider,
  saved,
  open,
  canWrite,
  profiles,
  onOpen,
  onSignIn,
  onCancel,
  onSaved,
}: {
  provider: VaultCatalogProvider;
  saved: number;
  open: boolean;
  canWrite: boolean;
  profiles: readonly HqVaultProfileMeta[];
  onOpen: () => void;
  onSignIn: () => void;
  onCancel: () => void;
  onSaved: (id: string) => Promise<void>;
}): ReactNode {
  const signInOnly = isSignInOnly(provider);
  return (
    <div
      className={cn(
        'flex flex-col border border-border bg-card',
        open && 'border-primary sm:col-span-2 xl:col-span-3',
      )}
      data-testid="vault-catalog-card"
    >
      <div className="flex items-center gap-3 p-3">
        <ProviderLogo id={provider.id} baseUrl={provider.apiBase} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate text-sm font-medium">
            {provider.name}
            {saved > 0 && (
              <span className="bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success">
                {saved} saved
              </span>
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {provider.id} · {familyTitle(provider.family)} · {provider.models.length} models
          </p>
        </div>
        {signInOnly ? (
          <button
            type="button"
            className={smallButton}
            onClick={onSignIn}
            title="This provider takes a subscription sign-in, not a pasted key"
          >
            Sign in
          </button>
        ) : (
          canWrite &&
          !open && (
            <button
              type="button"
              className={smallButton}
              onClick={onOpen}
              aria-label={`Add ${provider.name}`}
            >
              <Plus className="size-3.5" aria-hidden />
            </button>
          )
        )}
      </div>
      {open && (
        <CatalogKeyForm
          provider={provider}
          profiles={profiles}
          onCancel={onCancel}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}

function CatalogKeyForm({
  provider,
  profiles,
  onCancel,
  onSaved,
}: {
  provider: VaultCatalogProvider;
  profiles: readonly HqVaultProfileMeta[];
  onCancel: () => void;
  onSaved: (id: string) => Promise<void>;
}): ReactNode {
  const id = useId();
  const [alias, setAlias] = useState(() => nextProfileId(provider.id, profiles));
  const [keyLabel, setKeyLabel] = useState('default');
  const [apiKey, setApiKey] = useState('');
  const { busy, message, setMessage, run } = useVaultAction();
  return (
    <form
      className="flex flex-col gap-3 border-t border-border bg-muted/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const problem =
          profileIdError(alias, profiles) ??
          (keyLabel.trim() === '' ? 'Name the key.' : null) ??
          (apiKey.trim() === '' ? 'Paste the key.' : null);
        if (problem) {
          setMessage({ tone: 'error', text: problem });
          return;
        }
        void run(async () => {
          await createVaultProfile({
            id: alias.trim(),
            type: provider.id,
            apiKey: apiKey.trim(),
            keyLabel: keyLabel.trim(),
          });
          await onSaved(alias.trim());
        });
      }}
    >
      {provider.envVars.length > 0 && (
        <p className="text-xs text-muted-foreground">
          The key you would put in {provider.envVars.join(' or ')}.
          {provider.doc && (
            <>
              {' '}
              <a className="underline" href={provider.doc} target="_blank" rel="noreferrer">
                Where to get one
              </a>
            </>
          )}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,9rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-alias`} className={label}>
            Alias
          </label>
          <input
            id={`${id}-alias`}
            className={field}
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-label`} className={label}>
            Key name
          </label>
          <input
            id={`${id}-label`}
            className={field}
            value={keyLabel}
            onChange={(event) => setKeyLabel(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-key`} className={label}>
            API key
          </label>
          <input
            id={`${id}-key`}
            className={cn(field, 'font-mono')}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-…"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </div>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? 'Saving…' : `Save ${provider.name}`}
        </button>
        <button type="button" className="h-10 px-3 text-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <MessageLine message={message} />
    </form>
  );
}

function CustomProviderForm({
  profiles,
  onCancel,
  onSaved,
}: {
  profiles: readonly HqVaultProfileMeta[];
  onCancel: () => void;
  onSaved: (id: string) => Promise<void>;
}): ReactNode {
  const id = useId();
  const [alias, setAlias] = useState('');
  const [family, setFamily] = useState<string>(WIRE_FAMILIES[0].id);
  const [baseUrl, setBaseUrl] = useState('');
  const [models, setModels] = useState('');
  const [keyLabel, setKeyLabel] = useState('default');
  const [apiKey, setApiKey] = useState('');
  const { busy, message, setMessage, run } = useVaultAction();
  return (
    <form
      className="flex flex-col gap-3 border-t border-border pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        const problem = profileIdError(alias, profiles) ?? baseUrlError(baseUrl, true);
        if (problem) {
          setMessage({ tone: 'error', text: problem });
          return;
        }
        const modelList = parseModelList(models);
        void run(async () => {
          await createVaultProfile({
            id: alias.trim(),
            family,
            baseUrl: baseUrl.trim(),
            ...(modelList ? { models: modelList } : {}),
            ...(apiKey.trim()
              ? { apiKey: apiKey.trim(), keyLabel: keyLabel.trim() || 'default' }
              : {}),
          });
          await onSaved(alias.trim());
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-alias`} className={label}>
            Alias
          </label>
          <input
            id={`${id}-alias`}
            className={field}
            placeholder="team-proxy"
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-family`} className={label}>
            Speaks
          </label>
          <select
            id={`${id}-family`}
            className={field}
            value={family}
            onChange={(event) => setFamily(event.target.value)}
          >
            {WIRE_FAMILIES.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <label htmlFor={`${id}-url`} className={label}>
            Endpoint
          </label>
          <input
            id={`${id}-url`}
            className={cn(field, 'font-mono')}
            placeholder="https://llm.example.com/v1"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <label htmlFor={`${id}-models`} className={label}>
            Models (optional, comma separated)
          </label>
          <input
            id={`${id}-models`}
            className={field}
            placeholder="empty = ask the endpoint"
            value={models}
            onChange={(event) => setModels(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-label`} className={label}>
            Key name
          </label>
          <input
            id={`${id}-label`}
            className={field}
            value={keyLabel}
            onChange={(event) => setKeyLabel(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-key`} className={label}>
            API key (optional for keyless servers)
          </label>
          <input
            id={`${id}-key`}
            className={cn(field, 'font-mono')}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </div>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? 'Saving…' : 'Save custom provider'}
        </button>
        <button type="button" className="h-10 px-3 text-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <MessageLine message={message} />
    </form>
  );
}
