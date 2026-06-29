import {
  CheckCircle2,
  Eye,
  EyeOff,
  Globe,
  Key,
  Loader2,
  Plus,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from '@/components/Toaster';
import { cn } from '@/lib/utils';
import type { WrongStackWebSocketClient } from '@/lib/ws-client';
import type { WSServerMessage } from '@/types';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
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

  // ── Inline catalog keying + save-time probe ──
  const [inlineKeyFor, setInlineKeyFor] = useState<string | null>(null);
  const [inlineKeyValue, setInlineKeyValue] = useState('');
  const [inlineKeyReveal, setInlineKeyReveal] = useState(false);
  const [probeResults, setProbeResults] = useState<
    Record<string, { ok: boolean; status: string; detail?: string | undefined }>
  >({});

  const savedIds = useMemo(() => new Set(savedProviders.map((s) => s.id)), [savedProviders]);

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
      toast.success(`Saved key for ${p.name}`);
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
          Subscription login
        </h3>
        <OAuthLoginSection ws={ws} />
      </div>

      <div className="pt-2 border-t">
        <h3 className="text-sm font-semibold mb-1 flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          API key providers
        </h3>
        <p className="text-xs text-muted-foreground mb-3">
          Pick a provider from the catalog and add an API key, or manage saved providers.
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
          Catalog
        </Button>
        <Button
          variant={providerTab === 'saved' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setProviderTab('saved')}
        >
          <Key className="h-4 w-4 mr-1" />
          Saved ({savedProviders.length})
        </Button>
      </div>

      {/* Catalog View */}
      {providerTab === 'catalog' && (
        <div className="space-y-4">
          <Input
            placeholder={`Search ${catalogProviders.length} providers (name / id / family)…`}
            value={catalogQuery}
            onChange={(e) => setCatalogQuery(e.target.value)}
            className="text-sm"
          />
          {isLoadingCatalog && catalogProviders.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-muted-foreground">Loading catalog...</span>
            </div>
          ) : filteredCatalog.length === 0 && catalogQuery ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              No providers match "<span className="font-mono">{catalogQuery}</span>".
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
                                  <span className="text-xs bg-green-500/10 text-green-600 px-2 py-0.5 rounded">
                                    <Key className="h-3 w-3 inline mr-1" />
                                    Configured
                                  </span>
                                )}
                                {probe && (
                                  <span
                                    className={cn(
                                      'text-xs px-2 py-0.5 rounded inline-flex items-center gap-1',
                                      probe.ok
                                        ? 'bg-green-500/10 text-green-600'
                                        : 'bg-destructive/10 text-destructive',
                                    )}
                                    title={probe.detail ?? probe.status}
                                  >
                                    {probe.ok ? (
                                      <CheckCircle2 className="h-3 w-3" />
                                    ) : (
                                      <XCircle className="h-3 w-3" />
                                    )}
                                    {probe.ok ? 'Reachable' : probe.status}
                                  </span>
                                )}
                                {p.envVars[0] && (
                                  <span className="text-xs text-muted-foreground">
                                    ENV: {p.envVars[0]}
                                  </span>
                                )}
                                {selected && <CheckCircle2 className="h-4 w-4 text-primary" />}
                              </div>
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">
                              {p.modelCount} models
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
                                      placeholder={`${p.name} API key`}
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
                                      Save
                                    </Button>
                                  </div>
                                  {p.envVars[0] && (
                                    <p className="text-xs text-muted-foreground">
                                      Or set{' '}
                                      <code className="bg-muted px-1 rounded">{p.envVars[0]}</code>{' '}
                                      in the environment instead.
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
                                  Add API key
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
          <div className="flex justify-between items-center">
            <p className="text-sm text-muted-foreground">
              Manage your API keys and provider configurations
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowAddProviderForm(!showAddProviderForm)}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add Provider
            </Button>
          </div>

          {/* Add Provider Form */}
          {showAddProviderForm && (
            <div className="p-4 border rounded-lg space-y-3 bg-muted/50">
              <h4 className="font-medium">Add Custom Provider</h4>
              <Input
                placeholder="Provider ID (e.g. my-llm-server)"
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
                placeholder="API Key (optional)"
                value={newProviderApiKey}
                onChange={(e) => setNewProviderApiKey(e.target.value)}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAddProvider} disabled={!newProviderId.trim()}>
                  Add
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowAddProviderForm(false)}>
                  Cancel
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
              <p>No saved providers yet</p>
              <p className="text-sm">Add a provider to get started</p>
            </div>
          ) : (
            savedProviders.map((sp) => (
              <div key={sp.id} className="border rounded-lg p-4 space-y-3">
                <div className="flex justify-between items-start">
                  <div>
                    <h4 className="font-medium">{sp.id}</h4>
                    {sp.family && (
                      <span className="text-xs text-muted-foreground">{sp.family}</span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button size="icon" variant="ghost" onClick={() => onRemoveProvider(sp.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>

                {sp.baseUrl && (
                  <div className="text-xs text-muted-foreground">
                    <Globe className="h-3 w-3 inline mr-1" />
                    {sp.baseUrl}
                  </div>
                )}

                <ProviderModelsPanel
                  providerId={sp.id}
                  savedPickedModelId={sp.pickedModelId}
                  savedModels={sp.models}
                  ws={ws}
                  onPickModel={onPickProviderModel}
                />

                {/* API Keys */}
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium">API Keys</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setShowAddKeyForm(showAddKeyForm === sp.id ? null : sp.id)}
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      Add Key
                    </Button>
                  </div>

                  {sp.apiKeys.length === 0 && !showAddKeyForm && (
                    <p className="text-xs text-muted-foreground">No keys configured</p>
                  )}

                  {sp.apiKeys.map((key) => (
                    <div
                      key={key.label}
                      className="flex items-center justify-between p-2 bg-muted/50 rounded"
                    >
                      <div>
                        <span className="text-sm font-medium">{key.label}</span>
                        {key.isActive && (
                          <span className="ml-2 text-xs bg-green-500/10 text-green-600 px-1.5 py-0.5 rounded">
                            Active
                          </span>
                        )}
                        <div className="text-xs text-muted-foreground font-mono">
                          {key.maskedKey}
                        </div>
                      </div>
                      <div className="flex gap-1">
                        {!key.isActive && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onSetActiveKey(sp.id, key.label)}
                          >
                            Set Active
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => onDeleteKey(sp.id, key.label)}
                        >
                          <Trash2 className="h-3 w-3 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  ))}

                  {/* Add Key Form */}
                  {showAddKeyForm === sp.id && (
                    <div className="p-3 border rounded space-y-2 bg-background">
                      <Input
                        placeholder="Key label (e.g. default, production)"
                        value={newKeyLabel}
                        onChange={(e) => setNewKeyLabel(e.target.value)}
                      />
                      <div className="flex gap-2">
                        <Input
                          type={showNewKeyValue ? 'text' : 'password'}
                          placeholder="API key"
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
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => handleAddKey(sp.id)}
                          disabled={!newKeyLabel.trim() || !newKeyValue.trim()}
                        >
                          Save Key
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
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
