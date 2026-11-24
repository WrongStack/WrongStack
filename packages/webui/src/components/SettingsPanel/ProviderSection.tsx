import { CheckCircle2, Eye, EyeOff, Globe, Key, Loader2, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ProviderLogo } from '@/components/ProviderLogo';
import { toast } from '@/components/Toaster';
import { useFieldKeyboardNav } from '@/hooks/useFieldKeyboardNav';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { WSServerMessage } from '@/types';
import type { ModelEntry } from '../SetupScreen/ModelEditor';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { LOCAL_PRESET_FAMILY, type LOCAL_SERVER_PRESETS } from './local-presets';
import { OAuthLoginSection } from './OAuthLoginSection';
import { ProviderHqImport } from './ProviderHqImport';
import { ProviderSavedProfiles } from './ProviderSavedProfiles.js';
import type { CatalogProvider, ProviderSectionProps } from './provider-section-types.js';

export type {
  CatalogProvider,
  ProviderTab,
  SavedProvider,
} from './provider-section-types.js';

const PROVIDER_FAMILIES = ['anthropic', 'openai', 'google', 'openai-compatible'] as const;

// ── Component ──

export function ProviderSection({
  activeProvider,
  catalogProviders,
  isLoadingCatalog,
  savedProviders,
  isLoadingSaved,
  providerTab,
  setProviderTab,
  onSelectProvider,
  onAddKey,
  onDeleteKey,
  onSetActiveKey,
  onAddProvider,
  onRemoveProvider,
  onPickProviderModel,
  disabledProviders,
  onToggleProviderDisabled,
  ws,
  catalogQuery,
  setCatalogQuery,
}: ProviderSectionProps) {
  const { t } = useAppTranslation();
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const save = useCallback(
    async (action: () => Promise<boolean | void> | void, confirmed: () => void) => {
      if (savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      try {
        if ((await action()) === true) confirmed();
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [],
  );
  // Key management form state
  const [showAddKeyForm, setShowAddKeyForm] = useState<string | null>(null);
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [showNewKeyValue, setShowNewKeyValue] = useState(false);

  // Add provider form state
  const [showAddProviderForm, setShowAddProviderForm] = useState(false);
  const [newProviderId, setNewProviderId] = useState('');
  const [newProviderFamily, setNewProviderFamily] = useState('openai-compatible');
  const [newProviderBaseUrl, setNewProviderBaseUrl] = useState('');
  const [newProviderApiKey, setNewProviderApiKey] = useState('');
  const [newProviderModels, setNewProviderModels] = useState<ModelEntry[]>([]);

  const addProviderNav = useFieldKeyboardNav();
  const addKeyNav = useFieldKeyboardNav();

  const handleAddKey = useCallback(
    (providerId: string) => {
      if (!newKeyLabel.trim() || !newKeyValue.trim()) return;
      void save(
        () => onAddKey(providerId, newKeyLabel.trim(), newKeyValue.trim()),
        () => {
          setNewKeyLabel('');
          setNewKeyValue('');
          setShowAddKeyForm(null);
        },
      );
    },
    [onAddKey, newKeyLabel, newKeyValue, save],
  );

  const handleAddProvider = useCallback(() => {
    if (!newProviderId.trim()) return;
    void save(
      () =>
        onAddProvider(
          newProviderId.trim(),
          newProviderFamily,
          newProviderBaseUrl || undefined,
          newProviderApiKey || undefined,
          newProviderModels.length > 0 ? newProviderModels.map((m) => m.id) : undefined,
          newProviderModels.length > 0
            ? Object.fromEntries(
                newProviderModels
                  .filter(
                    (m) =>
                      m.name ||
                      m.maxOutput ||
                      (m.capabilities && Object.keys(m.capabilities).length > 0),
                  )
                  .map((m) => [
                    m.id,
                    {
                      ...(m.name && m.name !== m.id ? { name: m.name } : {}),
                      ...(m.maxOutput ? { maxOutput: m.maxOutput } : {}),
                      ...(m.capabilities && Object.keys(m.capabilities).length > 0
                        ? { capabilities: m.capabilities }
                        : {}),
                    },
                  ]),
              )
            : undefined,
        ),
      () => {
        setNewProviderId('');
        setNewProviderFamily('openai-compatible');
        setNewProviderBaseUrl('');
        setNewProviderApiKey('');
        setNewProviderModels([]);
        setShowAddProviderForm(false);
      },
    );
  }, [
    onAddProvider,
    newProviderId,
    newProviderFamily,
    newProviderBaseUrl,
    newProviderApiKey,
    newProviderModels,
    save,
  ]);

  /**
   * Pre-fill the Add Provider form from a local-server preset (OmniRoute /
   * Ollama / vLLM / LM Studio) — the WebUI parallel to the CLI's
   * `wstack auth local` quick-pick. Keyless (noAuth) presets clear the key
   * field; keyed ones leave whatever the user already typed.
   */
  const handlePickLocalPreset = useCallback((preset: (typeof LOCAL_SERVER_PRESETS)[number]) => {
    setNewProviderId(preset.id);
    setNewProviderFamily(LOCAL_PRESET_FAMILY);
    setNewProviderBaseUrl(preset.defaultBaseUrl);
    if (preset.noAuth) setNewProviderApiKey('');
    setNewProviderModels([]);
  }, []);

  // ── Inline catalog keying + save-time probe ──
  const [inlineKeyFor, setInlineKeyFor] = useState<string | null>(null);
  const [inlineKeyValue, setInlineKeyValue] = useState('');
  const [inlineProfileAlias, setInlineProfileAlias] = useState('');
  const [inlineKeyReveal, setInlineKeyReveal] = useState(false);
  const [probeResults, setProbeResults] = useState<
    Record<string, { ok: boolean; status: string; detail?: string | undefined }>
  >({});

  const savedIds = useMemo(() => new Set(savedProviders.map((s) => s.id)), [savedProviders]);
  const savedProviderStats = useMemo(
    () => ({
      keys: savedProviders.reduce((sum, sp) => sum + sp.apiKeys.length, 0),
      activeKeys: savedProviders.reduce(
        (sum, sp) => sum + sp.apiKeys.filter((key) => key.isActive).length,
        0,
      ),
      models: savedProviders.reduce((sum, sp) => sum + (sp.models?.length ?? 0), 0),
    }),
    [savedProviders],
  );

  useEffect(() => {
    const off = ws.on('provider.probe', (msg: WSServerMessage) => {
      if (msg.type !== 'provider.probe') return;
      const p = msg.payload as { providerId: string; ok: boolean; status: string; detail?: string };
      // `no_base_url` / `no_provider` aren't actionable for cloud providers —
      // skip them so we never show a misleading red mark.
      if (p.status === 'no_base_url' || p.status === 'no_provider') return;
      setProbeResults((prev) => ({
        ...prev,
        [p.providerId]: { ok: p.ok, status: p.status, detail: p.detail },
      }));
    });
    return () => off?.();
  }, [ws]);

  const handleInlineKeySave = useCallback(
    (p: CatalogProvider) => {
      const key = inlineKeyValue.trim();
      const alias = inlineProfileAlias.trim();
      if (!key || !alias) return;
      if (savedIds.has(alias)) {
        toast.error(t('settings:provider.profileExists', { alias }));
        return;
      }
      void save(
        () =>
          onAddProvider(alias, p.family, p.apiBase ?? undefined, key, undefined, undefined, p.id),
        () => {
          setInlineKeyValue('');
          setInlineKeyFor(null);
          setInlineKeyReveal(false);
          if (p.apiBase) ws.probeProvider(alias, 6000);
        },
      );
    },
    [inlineKeyValue, inlineProfileAlias, savedIds, onAddProvider, ws, t, save],
  );

  // ── Filter + group catalog ──

  const filteredCatalog = catalogQuery.trim()
    ? catalogProviders.filter((p) => {
        const q = catalogQuery.trim().toLowerCase();
        return (
          p.id.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q) ||
          p.family.toLowerCase().includes(q)
        );
      })
    : catalogProviders;
  // Provider catalogs are bounded, show all without pagination.

  const catalogByFamily = filteredCatalog.reduce(
    (acc, p) => {
      if (!acc[p.family]) acc[p.family] = [];
      acc[p.family]?.push(p);
      return acc;
    },
    {} as Record<string, CatalogProvider[]>,
  );

  // ── Render ──

  return (
    <div className="space-y-4">
      {/* Registry-driven provider sign-in */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Key className="h-4 w-4 text-muted-foreground" />
          {t('settings:provider.subscriptionHeading')}
        </h3>
        <OAuthLoginSection
          ws={ws}
          savedProviders={savedProviders.map((sp) => ({
            id: sp.id,
            type: sp.type,
            family: sp.family,
            hasActiveKey: sp.apiKeys.some((key) => key.isActive),
          }))}
        />
      </div>

      <ProviderHqImport ws={ws} />

      <div className="pt-2 border-t">
        <h3 className="text-sm font-semibold mb-1 flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          {t('settings:provider.apiKeysHeading')}
        </h3>
        <p className="text-xs text-muted-foreground mb-3">{t('settings:provider.apiKeysBody')}</p>
      </div>

      {/* Provider source toggle */}
      <div className="flex flex-wrap gap-2 mb-4">
        <Button
          variant={providerTab === 'catalog' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setProviderTab('catalog')}
        >
          <Globe className="h-4 w-4 mr-1" />
          {t('settings:provider.tabCatalog')}
        </Button>
        <Button
          variant={providerTab === 'saved' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setProviderTab('saved')}
        >
          <Key className="h-4 w-4 mr-1" />
          {t('settings:provider.tabSaved', { count: savedProviders.length })}
        </Button>
      </div>

      {/* Catalog View */}
      {providerTab === 'catalog' && (
        <div className="space-y-4">
          <Input
            placeholder={t('settings:provider.searchPlaceholder', {
              count: catalogProviders.length,
            })}
            value={catalogQuery}
            onChange={(e) => setCatalogQuery(e.target.value)}
            className="text-sm"
          />
          {isLoadingCatalog && catalogProviders.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-muted-foreground">
                {t('settings:provider.loadingCatalog')}
              </span>
            </div>
          ) : filteredCatalog.length === 0 && catalogQuery ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              {t('settings:provider.noMatch', { query: catalogQuery })}
            </div>
          ) : (
            PROVIDER_FAMILIES.map((family) => {
              const providers = catalogByFamily[family];
              if (!providers?.length) return null;
              return (
                <div key={family} className="space-y-2">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                    {family}
                  </h3>
                  <div className="grid grid-cols-1 gap-2">
                    {providers.map((p) => {
                      const probe = probeResults[p.id];
                      const selected = activeProvider === p.id;
                      return (
                        <div
                          key={p.id}
                          className={cn(
                            'rounded-lg border transition-all',
                            selected
                              ? 'border-primary bg-primary/5 ring-2 ring-primary/20'
                              : 'border-border',
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => onSelectProvider(p.id)}
                            className={cn(
                              'flex w-full flex-col items-start p-3 text-left rounded-lg',
                              !selected && 'hover:bg-muted',
                            )}
                          >
                            <div className="flex w-full flex-wrap gap-2 justify-between items-start">
                              <div className="flex min-w-0 items-center gap-2.5">
                                <ProviderLogo providerId={p.id} baseUrl={p.apiBase} />
                                <div className="min-w-0 break-words">
                                  <span className="font-medium">{p.name}</span>
                                  <span className="ml-2 text-xs text-muted-foreground">
                                    ({p.id})
                                  </span>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                {p.hasApiKey && (
                                  <span className="text-xs bg-success/10 text-success px-2 py-0.5 rounded">
                                    <Key className="h-3 w-3 inline mr-1" />
                                    {t('settings:provider.configured')}
                                  </span>
                                )}
                                {probe && (
                                  <span
                                    className={cn(
                                      'text-xs px-2 py-0.5 rounded inline-flex items-center gap-1',
                                      probe.ok
                                        ? 'bg-success/10 text-success'
                                        : 'bg-destructive/10 text-destructive',
                                    )}
                                    title={probe.detail ?? probe.status}
                                  >
                                    {probe.ok ? (
                                      <CheckCircle2 className="h-3 w-3" />
                                    ) : (
                                      <XCircle className="h-3 w-3" />
                                    )}
                                    {probe.ok ? t('settings:provider.reachable') : probe.status}
                                  </span>
                                )}
                                {p.envVars[0] && (
                                  <span className="text-xs text-muted-foreground">
                                    {t('settings:provider.envVar', { var: p.envVars[0] })}
                                  </span>
                                )}
                                {selected && <CheckCircle2 className="h-4 w-4 text-primary" />}
                              </div>
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">
                              {t('settings:provider.modelCount', { count: p.modelCount })}
                              {p.apiBase && ` · ${p.apiBase}`}
                            </div>
                          </button>

                          {/* Inline key entry — only when selected and not yet keyed. */}
                          {selected && (
                            <div className="px-3 pb-3 -mt-1 space-y-2">
                              {inlineKeyFor === p.id ? (
                                <>
                                  <label
                                    className="block text-xs"
                                    htmlFor={`auth-profile-alias-${p.id}`}
                                  >
                                    {t('settings:provider.profileAlias')}
                                    <Input
                                      id={`auth-profile-alias-${p.id}`}
                                      value={inlineProfileAlias}
                                      onChange={(e) => setInlineProfileAlias(e.target.value)}
                                    />
                                  </label>
                                  <p className="text-xs text-muted-foreground">
                                    {t('settings:provider.profileHint')}
                                  </p>
                                  <div className="flex gap-2">
                                    <Input
                                      autoFocus
                                      type={inlineKeyReveal ? 'text' : 'password'}
                                      placeholder={t('settings:provider.keyPlaceholder', {
                                        name: p.name,
                                      })}
                                      value={inlineKeyValue}
                                      onChange={(e) => setInlineKeyValue(e.target.value)}
                                      className="text-sm"
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleInlineKeySave(p);
                                      }}
                                    />
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      onClick={() => setInlineKeyReveal((v) => !v)}
                                    >
                                      {inlineKeyReveal ? (
                                        <EyeOff className="h-4 w-4" />
                                      ) : (
                                        <Eye className="h-4 w-4" />
                                      )}
                                    </Button>
                                    <Button
                                      size="sm"
                                      onClick={() => handleInlineKeySave(p)}
                                      disabled={
                                        saving ||
                                        !inlineKeyValue.trim() ||
                                        !inlineProfileAlias.trim()
                                      }
                                    >
                                      {t('common:action.save')}
                                    </Button>
                                  </div>
                                  {p.envVars[0] && (
                                    <p className="text-xs text-muted-foreground">
                                      {t('settings:provider.orEnv', { env: p.envVars[0] })}
                                    </p>
                                  )}
                                </>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setInlineKeyFor(p.id);
                                    setInlineKeyValue('');
                                    let alias = p.id;
                                    for (let n = 2; savedIds.has(alias); n++)
                                      alias = `${p.id}-${n}`;
                                    setInlineProfileAlias(alias);
                                  }}
                                >
                                  <Key className="h-3.5 w-3.5 mr-1" />
                                  {t('settings:provider.addProfile')}
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Saved Providers View */}
      {providerTab === 'saved' && (
        <ProviderSavedProfiles
          t={t}
          savedProviders={savedProviders}
          savedProviderStats={savedProviderStats}
          setShowAddProviderForm={setShowAddProviderForm}
          showAddProviderForm={showAddProviderForm}
          newProviderId={newProviderId}
          handlePickLocalPreset={handlePickLocalPreset}
          setNewProviderId={setNewProviderId}
          addProviderNav={addProviderNav}
          newProviderFamily={newProviderFamily}
          setNewProviderFamily={setNewProviderFamily}
          newProviderBaseUrl={newProviderBaseUrl}
          setNewProviderBaseUrl={setNewProviderBaseUrl}
          newProviderApiKey={newProviderApiKey}
          setNewProviderApiKey={setNewProviderApiKey}
          newProviderModels={newProviderModels}
          setNewProviderModels={setNewProviderModels}
          handleAddProvider={handleAddProvider}
          saving={saving}
          isLoadingSaved={isLoadingSaved}
          save={save}
          onRemoveProvider={onRemoveProvider}
          ws={ws}
          onPickProviderModel={onPickProviderModel}
          disabledProviders={disabledProviders}
          onToggleProviderDisabled={onToggleProviderDisabled}
          setShowAddKeyForm={setShowAddKeyForm}
          showAddKeyForm={showAddKeyForm}
          onSetActiveKey={onSetActiveKey}
          onDeleteKey={onDeleteKey}
          newKeyLabel={newKeyLabel}
          setNewKeyLabel={setNewKeyLabel}
          addKeyNav={addKeyNav}
          showNewKeyValue={showNewKeyValue}
          newKeyValue={newKeyValue}
          setNewKeyValue={setNewKeyValue}
          setShowNewKeyValue={setShowNewKeyValue}
          handleAddKey={handleAddKey}
        />
      )}
    </div>
  );
}
