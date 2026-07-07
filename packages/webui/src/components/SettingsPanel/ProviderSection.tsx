import {
  CheckCircle2,
  Cpu,
  Eye,
  EyeOff,
  Globe,
  Key,
  Loader2,
  Plus,
  Server,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { toast } from '@/components/Toaster';
import { cn } from '@/lib/utils';
import type { WrongStackWebSocketClient } from '@/lib/ws-client';
import type { WSServerMessage } from '@/types';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { LOCAL_PRESET_FAMILY, LOCAL_SERVER_PRESETS } from './local-presets';
import { OAuthLoginSection } from './OAuthLoginSection';
import { ProviderModelsPanel } from './ProviderModelsPanel';

// ── Types (shared with index) ──

export interface CatalogProvider {
  id: string;
  name: string;
  family: string;
  apiBase?: string | undefined;
  envVars: string[];
  modelCount: number;
  hasApiKey: boolean;
}

export interface SavedProvider {
  id: string;
  family?: string | undefined;
  baseUrl?: string | undefined;
  /** Saved model allowlist, in the order the user pinned them. */
  models?: string[] | undefined;
  /** First entry of `models`, surfaced for the panel's "Using" line. */
  pickedModelId?: string | undefined;
  apiKeys: Array<{
    label: string;
    maskedKey: string;
    isActive: boolean;
    createdAt: string;
  }>;
}

export type ProviderTab = 'catalog' | 'saved';

export const PROVIDER_FAMILIES = ['anthropic', 'openai', 'google', 'openai-compatible'] as const;

// ── Props ──

export interface ProviderSectionProps {
  /** Currently selected provider id. */
  activeProvider: string;
  /** Catalog providers list. */
  catalogProviders: CatalogProvider[];
  /** Loading flag. */
  isLoadingCatalog: boolean;
  /** Saved providers list. */
  savedProviders: SavedProvider[];
  /** Loading flag. */
  isLoadingSaved: boolean;
  /** Which sub-tab is active. */
  providerTab: ProviderTab;
  setProviderTab: (v: ProviderTab) => void;
  /** Called when a catalog provider is selected. */
  onSelectProvider: (id: string) => void;
  /** Called to add an API key. */
  onAddKey: (providerId: string, label: string, value: string) => void;
  /** Called to delete an API key. */
  onDeleteKey: (providerId: string, label: string) => void;
  /** Called to set a key as active. */
  onSetActiveKey: (providerId: string, label: string) => void;
  /** Called to add a custom provider. */
  onAddProvider: (
    id: string,
    family: string,
    baseUrl?: string | undefined,
    apiKey?: string,
  ) => void;
  /** Called to remove a saved provider. */
  onRemoveProvider: (providerId: string) => void;
  /** Called when a saved provider model is picked. */
  onPickProviderModel: (providerId: string, modelId: string) => void;
  /** WebSocket client used for saved-provider model probing/clearing. */
  ws: WrongStackWebSocketClient;
  /** Search filter text. */
  catalogQuery: string;
  setCatalogQuery: (v: string) => void;
}

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
  ws,
  catalogQuery,
  setCatalogQuery,
}: ProviderSectionProps) {
  const { t } = useAppTranslation();
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

  const handleAddKey = useCallback(
    (providerId: string) => {
      if (!newKeyLabel.trim() || !newKeyValue.trim()) return;
      onAddKey(providerId, newKeyLabel.trim(), newKeyValue.trim());
      setNewKeyLabel('');
      setNewKeyValue('');
      setShowAddKeyForm(null);
    },
    [onAddKey, newKeyLabel, newKeyValue],
  );

  const handleAddProvider = useCallback(() => {
    if (!newProviderId.trim()) return;
    onAddProvider(
      newProviderId.trim(),
      newProviderFamily,
      newProviderBaseUrl || undefined,
      newProviderApiKey || undefined,
    );
    setNewProviderId('');
    setNewProviderFamily('openai-compatible');
    setNewProviderBaseUrl('');
    setNewProviderApiKey('');
    setShowAddProviderForm(false);
  }, [onAddProvider, newProviderId, newProviderFamily, newProviderBaseUrl, newProviderApiKey]);

  /**
   * Pre-fill the Add Provider form from a local-server preset (OmniRoute /
   * Ollama / vLLM / LM Studio) — the WebUI parallel to the CLI's
   * `wstack auth local` quick-pick. Keyless (noAuth) presets clear the key
   * field; keyed ones leave whatever the user already typed.
   */
  const handlePickLocalPreset = useCallback(
    (preset: (typeof LOCAL_SERVER_PRESETS)[number]) => {
      setNewProviderId(preset.id);
      setNewProviderFamily(LOCAL_PRESET_FAMILY);
      setNewProviderBaseUrl(preset.defaultBaseUrl);
      if (preset.noAuth) setNewProviderApiKey('');
    },
    [],
  );

  // ── Inline catalog keying + save-time probe ──
  const [inlineKeyFor, setInlineKeyFor] = useState<string | null>(null);
  const [inlineKeyValue, setInlineKeyValue] = useState('');
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
      if (!key) return;
      if (savedIds.has(p.id)) {
        onAddKey(p.id, 'default', key);
      } else {
        onAddProvider(p.id, p.family, p.apiBase ?? undefined, key);
      }
      setInlineKeyValue('');
      setInlineKeyFor(null);
      setInlineKeyReveal(false);
      toast.success(t('settings:provider.savedToast', { name: p.name }));
      // Probe shortly after so the config write lands first. Only meaningful
      // when the provider exposes a base URL to hit.
      if (p.apiBase) setTimeout(() => ws.probeProvider(p.id, 6000), 700);
    },
    [inlineKeyValue, savedIds, onAddKey, onAddProvider, ws],
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
      {/* Subscription sign-in (ChatGPT / Claude / Copilot) */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Key className="h-4 w-4 text-muted-foreground" />
          {t('settings:provider.subscriptionHeading')}
        </h3>
        <OAuthLoginSection ws={ws} />
      </div>

      <div className="pt-2 border-t">
        <h3 className="text-sm font-semibold mb-1 flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          {t('settings:provider.apiKeysHeading')}
        </h3>
        <p className="text-xs text-muted-foreground mb-3">
          {t('settings:provider.apiKeysBody')}
        </p>
      </div>

      {/* Provider source toggle */}
      <div className="flex gap-2 mb-4">
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
            placeholder={t('settings:provider.searchPlaceholder', { count: catalogProviders.length })}
            value={catalogQuery}
            onChange={(e) => setCatalogQuery(e.target.value)}
            className="text-sm"
          />
          {isLoadingCatalog && catalogProviders.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-muted-foreground">{t('settings:provider.loadingCatalog')}</span>
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
                            <div className="flex w-full justify-between items-start">
                              <div>
                                <span className="font-medium">{p.name}</span>
                                <span className="ml-2 text-xs text-muted-foreground">({p.id})</span>
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
                          {selected && !p.hasApiKey && (
                            <div className="px-3 pb-3 -mt-1 space-y-2">
                              {inlineKeyFor === p.id ? (
                                <>
                                  <div className="flex gap-2">
                                    <Input
                                      autoFocus
                                      type={inlineKeyReveal ? 'text' : 'password'}
                                      placeholder={t('settings:provider.keyPlaceholder', { name: p.name })}
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
                                      disabled={!inlineKeyValue.trim()}
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
                                  }}
                                >
                                  <Key className="h-3.5 w-3.5 mr-1" />
                                  {t('settings:provider.addApiKey')}
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
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {t('settings:provider.manageKeys')}
              </p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/30 px-2 py-1">
                  <Server className="h-3.5 w-3.5" />
                  {t('settings:provider.savedProviderCount', { count: savedProviders.length })}
                </span>
                <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/30 px-2 py-1">
                  <Key className="h-3.5 w-3.5" />
                  {t('settings:provider.keyCount', { count: savedProviderStats.keys })}
                </span>
                <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/30 px-2 py-1">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  {t('settings:provider.activeKeyCount', { count: savedProviderStats.activeKeys })}
                </span>
                <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/30 px-2 py-1">
                  <Cpu className="h-3.5 w-3.5" />
                  {t('settings:provider.modelCount', { count: savedProviderStats.models })}
                </span>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowAddProviderForm(!showAddProviderForm)}
            >
              <Plus className="h-4 w-4 mr-1" />
              {t('settings:provider.addProvider')}
            </Button>
          </div>

          {/* Add Provider Form */}
          {showAddProviderForm && (
            <div className="p-4 border rounded-lg space-y-3 bg-muted/50">
              <h4 className="font-medium">{t('settings:provider.addCustomHeading')}</h4>

              {/* Local-server quick-pick — mirrors the CLI's `wstack auth
                  local`. Click a preset to pre-fill id / family / baseUrl. */}
              <div className="space-y-1.5">
                <span className="text-xs text-muted-foreground">
                  {t('settings:provider.localServers')}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {LOCAL_SERVER_PRESETS.map((preset) => (
                    <Button
                      key={preset.id}
                      type="button"
                      size="sm"
                      variant={newProviderId === preset.id ? 'default' : 'outline'}
                      onClick={() => handlePickLocalPreset(preset)}
                      title={preset.hint}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
              </div>

              <Input
                placeholder={t('settings:provider.providerIdPlaceholder')}
                value={newProviderId}
                onChange={(e) => setNewProviderId(e.target.value)}
              />
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={newProviderFamily}
                onChange={(e) => setNewProviderFamily(e.target.value)}
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="openai-compatible">OpenAI Compatible</option>
                <option value="google">Google</option>
              </select>
              <Input
                placeholder="Base URL (optional, e.g. http://localhost:11434/v1)"
                value={newProviderBaseUrl}
                onChange={(e) => setNewProviderBaseUrl(e.target.value)}
              />
              <Input
                type="password"
                placeholder={t('settings:provider.apiKeyOptionalPlaceholder')}
                value={newProviderApiKey}
                onChange={(e) => setNewProviderApiKey(e.target.value)}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAddProvider} disabled={!newProviderId.trim()}>
                  {t('common:action.add')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowAddProviderForm(false)}>
                  {t('common:action.cancel')}
                </Button>
              </div>
            </div>
          )}

          {isLoadingSaved ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : savedProviders.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Key className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>{t('settings:provider.noSaved')}</p>
              <p className="text-sm">{t('settings:provider.noSavedHint')}</p>
            </div>
          ) : (
            savedProviders.map((sp) => (
              <div
                key={sp.id}
                className="rounded-lg border border-border/80 bg-card/70 p-4 shadow-sm shadow-black/[0.02]"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <h4 className="min-w-0 truncate font-mono text-sm font-semibold text-foreground">
                        {sp.id}
                      </h4>
                      {sp.family && (
                        <span className="rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {sp.family}
                        </span>
                      )}
                      {sp.apiKeys.some((key) => key.isActive) && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
                          <ShieldCheck className="h-3 w-3" />
                          {t('settings:provider.active')}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      {sp.baseUrl && (
                        <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background/60 px-2 py-1">
                          <Globe className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{sp.baseUrl}</span>
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-background/60 px-2 py-1">
                        <Cpu className="h-3.5 w-3.5" />
                        {t('settings:provider.modelCount', { count: sp.models?.length ?? 0 })}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-background/60 px-2 py-1">
                        <Key className="h-3.5 w-3.5" />
                        {t('settings:provider.keyCount', { count: sp.apiKeys.length })}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-2 sm:justify-end">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => onRemoveProvider(sp.id)}
                      aria-label={`Remove provider ${sp.id}`}
                      title={`Remove provider ${sp.id}`}
                      className="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>

                <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.85fr)]">
                  <ProviderModelsPanel
                    providerId={sp.id}
                    savedPickedModelId={sp.pickedModelId}
                    savedModels={sp.models}
                    ws={ws}
                    onPickModel={onPickProviderModel}
                  />

                  {/* API Keys */}
                  <div className="rounded-lg border border-border/70 bg-background/75 p-3 shadow-sm shadow-black/[0.02]">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="text-sm font-semibold">{t('settings:provider.apiKeysLabel')}</span>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {t('settings:provider.keyCount', { count: sp.apiKeys.length })}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setShowAddKeyForm(showAddKeyForm === sp.id ? null : sp.id)}
                        className="h-8 px-2 text-xs"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {t('settings:provider.addKey')}
                      </Button>
                    </div>

                    {sp.apiKeys.length === 0 && !showAddKeyForm && (
                      <p className="mt-3 rounded-md border border-dashed border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                        {t('settings:provider.noKeys')}
                      </p>
                    )}

                    {sp.apiKeys.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {sp.apiKeys.map((key) => (
                          <div
                            key={key.label}
                            className="flex flex-col gap-2 rounded-lg border border-border/70 bg-muted/20 p-2.5 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <div className="flex min-w-0 items-start gap-2">
                              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background text-muted-foreground">
                                <Key className="h-3.5 w-3.5" />
                              </span>
                              <div className="min-w-0">
                                <div className="flex min-w-0 flex-wrap items-center gap-2">
                                  <span className="truncate text-sm font-medium">
                                    {key.label}
                                  </span>
                                  {key.isActive && (
                                    <span className="rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
                                      {t('settings:provider.active')}
                                    </span>
                                  )}
                                </div>
                                <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                                  {key.maskedKey}
                                </div>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center justify-end gap-1">
                              {!key.isActive && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => onSetActiveKey(sp.id, key.label)}
                                  className="h-8 px-2 text-xs"
                                >
                                  {t('settings:provider.setActive')}
                                </Button>
                              )}
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => onDeleteKey(sp.id, key.label)}
                                aria-label={`Delete key ${key.label}`}
                                title={`Delete key ${key.label}`}
                                className="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              >
                                <Trash2 className="h-3.5 w-3.5 text-destructive" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Add Key Form */}
                    {showAddKeyForm === sp.id && (
                      <div className="mt-3 space-y-2 rounded-lg border border-border/70 bg-background p-3">
                        <Input
                          placeholder={t('settings:provider.keyLabelPlaceholder')}
                          value={newKeyLabel}
                          onChange={(e) => setNewKeyLabel(e.target.value)}
                        />
                        <div className="flex gap-2">
                          <Input
                            type={showNewKeyValue ? 'text' : 'password'}
                            placeholder={t('settings:provider.apiKeyPlaceholder')}
                            value={newKeyValue}
                            onChange={(e) => setNewKeyValue(e.target.value)}
                          />
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setShowNewKeyValue(!showNewKeyValue)}
                          >
                            {showNewKeyValue ? (
                              <EyeOff className="h-4 w-4" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </Button>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            onClick={() => handleAddKey(sp.id)}
                            disabled={!newKeyLabel.trim() || !newKeyValue.trim()}
                          >
                            {t('settings:provider.saveKey')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setShowAddKeyForm(null);
                              setNewKeyLabel('');
                              setNewKeyValue('');
                            }}
                          >
                            {t('common:action.cancel')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
