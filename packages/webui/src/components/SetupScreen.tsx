import { useWebSocket } from '@/hooks/useWebSocket';
import { useConfigStore } from '@/stores';
import type { WSServerMessage } from '@/types';
import { toast } from '@/components/Toaster';
import { getWSClient } from '@/lib/ws-client';
import { showPanel } from '@/lib/view-navigation';
import {
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  Globe,
  KeyRound,
  Loader2,
  RefreshCw,
  Sparkles,
  Shield,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePagination } from '@/hooks/usePagination';
import { useShallow } from 'zustand/react/shallow';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Pagination } from './ui/pagination';
import { cn } from '@/lib/utils';
import { useAppTranslation, i18n } from '@/i18n';
import { CustomProviderSection } from './SetupScreen/CustomProviderSection';
import {
  DEFAULT_POPULAR_PROVIDERS,
  loadPopularProviders,
  type PopularProvider,
} from './SetupScreen/popular-providers';
import { formatSetupRelativeTime } from './SetupScreen/relative-time';

// ── Types ──────────────────────────────────────────────────────────────────────

import { ProviderKeyCard } from './SetupScreen/ProviderKeyCard';
import { useSystemPromptStore } from '@/stores/system-prompt-store';
import type {
  CatalogModel,
  CatalogProvider,
  ProbeResult,
  SavedProvider,
} from './SetupScreen/types';
export function SetupScreen() {
  const { t } = useAppTranslation();
  const { model, setProvider, setModel, wsConnected, wsUrl } = useConfigStore(
    useShallow((s) => ({
      model: s.model,
      setProvider: s.setProvider,
      setModel: s.setModel,
      wsConnected: s.wsConnected,
      wsUrl: s.wsUrl,
    })),
  );
  useWebSocket();

  // Catalog data
  const [catalogProviders, setCatalogProviders] = useState<CatalogProvider[]>([]);
  const [catalogModels, setCatalogModels] = useState<Record<string, CatalogModel[]>>({});
  const [savedProviders, setSavedProviders] = useState<SavedProvider[]>([]);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [savedProviderIds, setSavedProviderIds] = useState<Set<string>>(new Set());

  // Probe results: 'probing' while in-flight, ProbeResult on completion,
  // or absent (undefined) when no probe has been run for a provider yet.
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult | 'probing'>>({});

  // Popular providers loaded from external JSON
  const [popularProviders, setPopularProviders] =
    useState<PopularProvider[]>(DEFAULT_POPULAR_PROVIDERS);
  const [isLoadingPopular, setIsLoadingPopular] = useState(false);
  const [popularRefreshNonce, setPopularRefreshNonce] = useState(0);
  const [previousProviderCount, setPreviousProviderCount] = useState(0);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const isInitialLoadRef = useRef(true);

  // Fetch popular providers from remote JSON on mount and when refresh is triggered
  useEffect(() => {
    const controller = new AbortController();
    // Try local file first (dev / self-hosted), then fall back to GitHub raw
    const localUrl = `${window.location.origin}/providers.json`;
    const githubUrl =
      'https://raw.githubusercontent.com/WrongStack/WrongStack/main/packages/webui/public/providers.json';

    setIsLoadingPopular(true);
    loadPopularProviders(localUrl, controller.signal)
      .then((local) => {
        if (local !== DEFAULT_POPULAR_PROVIDERS) {
          setPopularProviders(local);
          setIsLoadingPopular(false);

          // Show toast notification on refresh (not initial load)
          if (!isInitialLoadRef.current) {
            const diff = local.length - previousProviderCount;
            if (diff > 0) {
              toast.success(
                i18n.t('setup:screen.toasts.providersLoadedNew', { count: local.length, diff }),
              );
            } else if (diff < 0) {
              toast.success(
                i18n.t('setup:screen.toasts.providersLoadedRemoved', {
                  count: local.length,
                  diff: Math.abs(diff),
                }),
              );
            } else {
              toast.success(
                i18n.t('setup:screen.toasts.providersLoadedNoChanges', { count: local.length }),
              );
            }
            setPreviousProviderCount(local.length);
          }
          setLastUpdatedAt(new Date());
          return;
        }
        // Local didn't work, try GitHub
        return loadPopularProviders(githubUrl, controller.signal);
      })
      .then((result) => {
        if (result) {
          setPopularProviders(result);

          // Show toast notification on refresh (not initial load)
          if (!isInitialLoadRef.current) {
            const diff = result.length - previousProviderCount;
            if (diff > 0) {
              toast.success(
                i18n.t('setup:screen.toasts.providersLoadedNew', { count: result.length, diff }),
              );
            } else if (diff < 0) {
              toast.success(
                i18n.t('setup:screen.toasts.providersLoadedRemoved', {
                  count: result.length,
                  diff: Math.abs(diff),
                }),
              );
            } else {
              toast.success(
                i18n.t('setup:screen.toasts.providersLoadedNoChanges', { count: result.length }),
              );
            }
            setPreviousProviderCount(result.length);
          }
          setLastUpdatedAt(new Date());
        }
      })
      .catch(() => {
        /* keep defaults */

        // Show error toast on refresh (not initial load)
        if (!isInitialLoadRef.current) {
          toast.error(i18n.t('setup:screen.toasts.providersRefreshFailed'));
        }
      })
      .finally(() => {
        setIsLoadingPopular(false);
        isInitialLoadRef.current = false;
      });

    return () => controller.abort();
  }, [popularRefreshNonce]);

  // Selected values (for the done step)
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [isLoadingModels, setIsLoadingModels] = useState(false);

  // Fetch provider catalog and saved providers on mount
  useEffect(() => {
    if (!wsConnected) return;

    const wsClient = getWSClient(wsUrl);
    let catalogTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      catalogTimeout = null;
      setIsLoadingCatalog(false);
      setCatalogError(i18n.t('setup:screen.errors.backendNotResponding'));
    }, 8000);
    const clearCatalogTimeout = () => {
      if (catalogTimeout) {
        clearTimeout(catalogTimeout);
        catalogTimeout = null;
      }
    };

    const off1 = wsClient.on('provider.catalog', (msg: WSServerMessage) => {
      if (msg.type === 'provider.catalog') {
        clearCatalogTimeout();
        setCatalogError(null);
        const payload = msg.payload as { providers: CatalogProvider[] };
        const sorted = payload.providers.sort((a, b) => a.id.localeCompare(b.id));
        setCatalogProviders(sorted);
        setIsLoadingCatalog(false);
      }
    });

    const off2 = wsClient.on('provider.models', (msg: WSServerMessage) => {
      if (msg.type === 'provider.models') {
        const payload = msg.payload as { provider: string; models: CatalogModel[] };
        // Ignore stale responses for a provider the user already switched away from
        if (payload.provider !== selectedProvider) return;
        setCatalogModels((prev) => ({ ...prev, [payload.provider]: payload.models }));
        setIsLoadingModels(false);

        if (payload.models.length === 1) {
          setSelectedModel(payload.models[0].id);
        } else if (model && payload.models.some((m) => m.id === model)) {
          setSelectedModel(model);
        }
      }
    });

    const off3 = wsClient.on('providers.saved', (msg: WSServerMessage) => {
      if (msg.type === 'providers.saved') {
        const payload = msg.payload as { providers: SavedProvider[] };
        const sorted = payload.providers.sort((a, b) => a.id.localeCompare(b.id));
        setSavedProviders(sorted);
        // Track which providers have saved keys
        const ids = new Set(
          sorted.filter((p) => p.apiKeys.some((k) => k.isActive)).map((p) => p.id),
        );
        setSavedProviderIds(ids);
      }
    });

    // Listen for health-probe responses and store by providerId.
    const off4 = wsClient.on('provider.probe', (msg: WSServerMessage) => {
      if (msg.type !== 'provider.probe') return;
      const result = msg.payload as ProbeResult & { providerId: string };
      setProbeResults((prev) => ({ ...prev, [result.providerId]: result }));
    });

    setCatalogError(null);
    setIsLoadingCatalog(true);
    wsClient.listProviders();

    return () => {
      clearCatalogTimeout();
      off1?.();
      off2?.();
      off3?.();
      off4?.();
    };
    // `selectedProvider` is READ by the `provider.models` handler above to
    // drop stale replies, so it has to be a dependency — without it the
    // handler closure kept the value from the last effect run (initially
    // `null`) and dropped EVERY reply. On a fresh install that meant: save an
    // Anthropic key → `handleKeySaved` sets `selectedProvider` (no listed dep
    // changes, so the effect never re-runs) → the server's model list is
    // discarded → `setIsLoadingModels(false)` never fires → the "Choose model"
    // pane spins forever and setup cannot be completed.
  }, [wsConnected, wsUrl, model, reloadNonce, selectedProvider]);

  // Retry catalog fetch
  const handleRetryCatalog = useCallback(() => {
    setCatalogError(null);
    setReloadNonce((n) => n + 1);
  }, []);

  // Refresh popular providers from external JSON
  const handleRefreshProviders = useCallback(() => {
    setPopularRefreshNonce((n) => n + 1);
  }, []);

  const formatRelativeTime = useCallback(
    (date: Date): string => formatSetupRelativeTime(date, t),
    [t],
  );

  const handleKeySaved = useCallback((providerId: string) => {
    setSavedProviderIds((prev) => new Set([...prev, providerId]));
    // Auto-select the provider so the model picker appears inline
    setSelectedProvider(providerId);
    setSelectedModel(null);
  }, []);

  const hasAnyKey = savedProviderIds.size > 0;

  // Fetch models when selected provider changes
  useEffect(() => {
    if (!selectedProvider || !wsConnected) return;
    const wsClient = getWSClient(wsUrl);
    if (!catalogModels[selectedProvider]) {
      setIsLoadingModels(true);
      wsClient.listProviderModels(selectedProvider);
    }
  }, [selectedProvider, wsConnected, wsUrl, catalogModels]);

  const currentModels = selectedProvider ? (catalogModels[selectedProvider] ?? []) : [];

  const handleStartSession = useCallback(async () => {
    if (!selectedProvider || !selectedModel) return;

    // Ensure the provider key is saved before starting a session
    if (!savedProviderIds.has(selectedProvider)) {
      toast.error('Please save the provider configuration before starting a session.');
      return;
    }

    setProvider(selectedProvider);
    setModel(selectedModel);

    const wsClient = getWSClient(wsUrl);
    const result = await wsClient.switchModel(selectedProvider, selectedModel, 5_000);
    if (result.success) {
      // First run in the truest sense: provider and model are settled, so the
      // last thing left to size is the system prompt. The picker starts the
      // session on confirm, and marks the question asked so App's first-run
      // effect does not raise it a second time.
      useSystemPromptStore.getState().openPicker({ startsSession: true });
      showPanel('chat');
    } else {
      toast.error(result.message || i18n.t('setup:screen.errors.modelSwitchTimeout'));
    }
  }, [selectedProvider, selectedModel, setProvider, setModel, wsUrl]);

  /** Save configuration and navigate to chat without creating a new session.
   *  The model.switch message persists the selection on the server and
   *  broadcasts a session.start so the chat view is ready. Unlike
   *  handleStartSession, this does NOT call newSession() — the user
   *  picks up the existing (or fresh) session and can start typing. */
  const handleSaveConfig = useCallback(async () => {
    if (!selectedProvider || !selectedModel) return;

    setProvider(selectedProvider);
    setModel(selectedModel);

    const wsClient = getWSClient(wsUrl);
    const result = await wsClient.switchModel(selectedProvider, selectedModel, 5_000);
    if (result.success) {
      showPanel('chat');
    } else {
      toast.error(result.message || i18n.t('setup:screen.errors.modelSwitchTimeout'));
    }
  }, [selectedProvider, selectedModel, setProvider, setModel, wsUrl]);

  // Sort providers: popular ones first, then catalog remainder
  const popularIds = new Set(popularProviders.map((p) => p.id));
  const additionalCatalog = catalogProviders
    .filter((p) => !popularIds.has(p.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const catalogPage = usePagination(additionalCatalog, 10);
  const _savedProviderPage = usePagination(savedProviders, 9);
  const modelPage = usePagination(currentModels, 12, selectedProvider);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* Header */}
      <header className="flex shrink-0 flex-col gap-3 border-b bg-card px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <img
            src="/wrongstack.svg"
            alt="WrongStack"
            draggable={false}
            className="ws-brand-logo h-10 w-10 shrink-0 border border-border/70 shadow-sm"
          />
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">{t('setup:screen.header.title')}</h1>
            <p className="text-xs text-muted-foreground sm:truncate">
              {t('setup:screen.header.subtitle')}
            </p>
          </div>
        </div>
        {hasAnyKey && selectedProvider ? (
          <span className="text-xs text-success/80">
            <Check className="h-3 w-3 inline-block mr-1" />
            {t('setup:screen.header.continue')}
          </span>
        ) : null}
      </header>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-3xl space-y-8 p-4 pb-4 sm:p-6">
          {/* Progress steps — all shown as available */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <div
              className={cn(
                'flex min-w-0 items-center gap-1.5',
                hasAnyKey ? 'text-success' : 'text-primary font-medium',
              )}
            >
              <KeyRound className="h-4 w-4" />
              <span>{t('setup:screen.steps.addKeys')}</span>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div
              className={cn(
                'flex min-w-0 items-center gap-1.5',
                selectedProvider ? 'text-primary font-medium' : 'text-muted-foreground',
              )}
            >
              <Bot className="h-4 w-4" />
              <span>{t('setup:screen.steps.pickModel')}</span>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div
              className={cn(
                'flex min-w-0 items-center gap-1.5',
                selectedProvider && selectedModel
                  ? 'text-primary font-medium'
                  : 'text-muted-foreground',
              )}
            >
              <Sparkles className="h-4 w-4" />
              <span>{t('setup:screen.steps.start')}</span>
            </div>
          </div>

          {/* Security note */}
          <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
            <Shield className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium">{t('setup:screen.security.title')}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t('setup:screen.security.body')}
              </p>
            </div>
          </div>

          {/* Popular Providers Grid */}
          {catalogError ? (
            <div className="flex flex-col items-center text-center gap-4 py-12 rounded-xl border border-destructive/30 bg-destructive/5 px-6">
              <div className="w-12 h-12 rounded-xl bg-destructive/10 border border-destructive/30 flex items-center justify-center">
                <Globe className="h-6 w-6 text-destructive" />
              </div>
              <div>
                <p className="text-sm font-medium text-destructive">
                  {t('setup:screen.errors.backendUnreachable')}
                </p>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">{catalogError}</p>
              </div>
              <Button onClick={handleRetryCatalog} size="sm" variant="outline">
                <Loader2 className="h-4 w-4 mr-2" />
                {t('setup:screen.errors.retry')}
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                    {t('setup:screen.providers.popular')}
                  </h2>
                  <div className="flex flex-wrap items-center gap-2">
                    {isLoadingPopular && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        {t('setup:screen.providers.updating')}
                      </span>
                    )}
                    {lastUpdatedAt && !isLoadingPopular && (
                      <span
                        className="text-[11px] text-muted-foreground"
                        title={lastUpdatedAt.toLocaleString()}
                      >
                        {formatRelativeTime(lastUpdatedAt)}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={handleRefreshProviders}
                      disabled={isLoadingPopular}
                      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title={t('setup:screen.providers.refreshTitle')}
                    >
                      <RefreshCw className={cn('h-3 w-3', isLoadingPopular && 'animate-spin')} />
                      {t('setup:screen.providers.refresh')}
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {popularProviders.map((p) => (
                    <ProviderKeyCard
                      key={p.id}
                      popular={p}
                      catalogProvider={catalogProviders.find((c) => c.id === p.id)}
                      savedProvider={savedProviders.find((s) => s.id === p.id)}
                      onKeySaved={handleKeySaved}
                      probeResult={probeResults[p.id] as ProbeResult | 'probing' | undefined}
                    />
                  ))}
                </div>
              </div>

              {/* Additional providers from catalog */}
              {additionalCatalog.length > 0 && (
                <div className="space-y-3">
                  <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                    {t('setup:screen.providers.more')}
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {catalogPage.pageItems.map((p) => (
                      <ProviderKeyCard
                        key={p.id}
                        popular={{
                          id: p.id,
                          name: p.name,
                          description: t('setup:screen.providers.catalogDescription', {
                            family: p.family,
                            count: p.modelCount,
                          }),
                          icon: '🔗',
                          color: 'from-muted/60 to-muted/20 border-border hover:border-primary/40',
                          keyPlaceholder: 'API key',
                          family: p.family,
                        }}
                        catalogProvider={p}
                        savedProvider={savedProviders.find((s) => s.id === p.id)}
                        onKeySaved={handleKeySaved}
                        probeResult={probeResults[p.id] as ProbeResult | 'probing' | undefined}
                      />
                    ))}
                  </div>
                  <Pagination
                    page={catalogPage.page}
                    pageSize={catalogPage.pageSize}
                    totalItems={catalogPage.totalItems}
                    onPageChange={catalogPage.setPage}
                    itemLabel="providers"
                  />
                </div>
              )}

              {/* Custom provider */}
              <div className="space-y-3">
                <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                  {t('setup:screen.providers.selfHosted')}
                </h2>
                <CustomProviderSection onKeySaved={handleKeySaved} />
              </div>
            </>
          )}

          {isLoadingCatalog && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {/* Model picker — inline below catalog when a provider is selected */}
          {selectedProvider && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" />
                  {t('setup:screen.start.chooseModel')}
                </h2>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedProvider(null);
                    setSelectedModel(null);
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t('setup:screen.start.addMoreKeys')}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('setup:screen.start.modelsFor', { provider: selectedProvider })}
              </p>
              {isLoadingModels ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : currentModels.length > 0 ? (
                <div className="grid grid-cols-1 gap-2">
                  {modelPage.pageItems.map((m) => {
                    const ctx = m.contextWindow
                      ? `${(m.contextWindow / 1_000_000).toFixed(0)}M ctx`
                      : null;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setSelectedModel(m.id)}
                        className={cn(
                          'w-full text-left rounded-xl border p-3 transition-all',
                          'hover:border-primary/40 hover:bg-primary/5',
                          selectedModel === m.id
                            ? 'border-primary bg-primary/10 ring-1 ring-primary/30'
                            : 'border-border bg-card',
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <span className="font-medium text-sm">{m.name}</span>
                            <div className="flex flex-wrap items-center gap-1.5 mt-1">
                              {ctx && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                  {ctx}
                                </span>
                              )}
                              {m.capabilities.slice(0, 3).map((cap) => (
                                <span
                                  key={cap}
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20"
                                >
                                  {cap}
                                </span>
                              ))}
                            </div>
                          </div>
                          {selectedModel === m.id && (
                            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary">
                              <Check className="h-3 w-3 text-primary-foreground" />
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  {t('setup:screen.errors.noModels')}
                </p>
              )}
              <Pagination
                page={modelPage.page}
                pageSize={modelPage.pageSize}
                totalItems={modelPage.totalItems}
                onPageChange={modelPage.setPage}
                itemLabel="models"
              />
            </div>
          )}

          {/* Action buttons — sticky footer when provider + model are selected */}
          {selectedProvider && selectedModel && (
            <div className="sticky bottom-0 -mx-4 border-t bg-background/80 px-4 py-4 backdrop-blur-sm sm:-mx-6 sm:px-6">
              <div className="mb-3 flex min-w-0 items-center justify-between gap-2 text-sm text-muted-foreground">
                <span className="min-w-0 truncate">
                  {selectedProvider} / {selectedModel}
                </span>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <Button onClick={handleStartSession} className="flex-1" size="lg">
                  <Bot className="h-4 w-4 mr-2" />
                  {t('setup:screen.start.startSession')}
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
                <Button onClick={handleSaveConfig} variant="outline" className="flex-1" size="lg">
                  <Check className="h-4 w-4 mr-2" />
                  {t('setup:screen.start.saveConfig')}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground/60 text-center mt-2">
                {t('setup:screen.start.saveConfigHint')}
              </p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
