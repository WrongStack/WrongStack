import {
  Activity,
  Bot,
  Brain,
  Cpu,
  Eye,
  Globe,
  Layers,
  ListPlus,
  Network,
  Palette,
  Puzzle,
  Send,
  Server,
  Shield,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { toast } from '@/components/Toaster';
import { useProviderModels } from '@/hooks/useProviderModels';
import { useScrollPosition } from '@/hooks/useScrollPosition';
import { useWebSocket } from '@/hooks/useWebSocket';
import { i18n, useAppTranslation } from '@/i18n';
import { showPanel } from '@/lib/view-navigation';
import { useConfigStore, useUIStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import type { WSServerMessage } from '@/types';
import { AvailabilityCalendarEditor } from '../AvailabilityCalendarEditor';
import { FallbackEditor } from '../FallbackEditor';
import { ModelSelectDialog } from '../ModelSelectDialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { BrainSection } from './BrainSection';
import { AppearanceSettingsTab, ConnectionSettingsTab } from './BasicSettingsTabs';
import { ChimeraSettingsPanel } from './ChimeraSettingsPanel';
import { MCPSection } from './MCPSection';
import { ModelSection } from './ModelSection';
import { PluginToggleList } from './PluginToggleList';
import { PreferenceSelect, PreferenceSlider } from './PreferenceControls';
import { PreferenceToggle } from './PreferenceToggle';
import {
  type CatalogProvider,
  ProviderSection,
  type ProviderTab,
  type SavedProvider,
} from './ProviderSection';
import { RoutingSection } from './RoutingSection';
import { ShadowSection } from './ShadowSection';
import { ToolsSection } from './ToolsSection';

interface CatalogModel {
  id: string;
  name: string;
  releaseDate?: string | undefined;
  contextWindow?: number | undefined;
  inputCost?: number | undefined;
  outputCost?: number | undefined;
  capabilities: string[];
}

export function SettingsPanel() {
  const { settingsActiveTab, setSettingsActiveTab } = useUIStore(
    useShallow((s) => ({
      settingsActiveTab: s.settingsActiveTab,
      setSettingsActiveTab: s.setSettingsActiveTab,
    })),
  );
  const scrollAreaRef = useScrollPosition('settings');

  const {
    provider,
    model: activeModel,
    setProvider,
    setModel,
    wsConnected,
  } = useConfigStore(
    useShallow((s) => ({
      provider: s.provider,
      model: s.model,
      setProvider: s.setProvider,
      setModel: s.setModel,
      wsConnected: s.wsConnected,
    })),
  );
  const ws = useWebSocket();
  const wsClient = ws.client;
  const { updatePrefs, switchAutonomy } = ws;
  const localPrefs = useLocalPrefs();
  const { t } = useAppTranslation();
  // Model catalogue for the global fallback chain editor (fetched while open).
  const fallbackCandidates = useProviderModels(true);

  // Helper: apply a pref change locally AND push it to the server so the
  // running agent sees the new value immediately. Uses the batch
  // prefs.update message for efficient multi-key updates.
  const syncPref = useCallback(
    (key: string, value: unknown) => {
      localPrefs.set({ [key]: value } as Parameters<typeof localPrefs.set>[0]);
      updatePrefs({ [key]: value });
    },
    [localPrefs, updatePrefs],
  );


  // Catalog data (unchanged)
  const [catalogProviders, setCatalogProviders] = useState<CatalogProvider[]>([]);
  const [catalogModels, setCatalogModels] = useState<Record<string, CatalogModel[]>>({});
  const [savedProviders, setSavedProviders] = useState<SavedProvider[]>([]);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isLoadingSaved, setIsLoadingSaved] = useState(false);
  const [providerTab, setProviderTab] = useState<ProviderTab>('catalog');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [newFallbackProfileName, setNewFallbackProfileName] = useState('');
  const [refinerPickerOpen, setRefinerPickerOpen] = useState(false);
  const currentCatalogProvider = catalogProviders.find((p) => p.id === provider);

  // WS event subscriptions
  useEffect(() => {
    const handleProviderCatalog = (msg: WSServerMessage) => {
      if (msg.type === 'provider.catalog') {
        const payload = msg.payload as { providers: CatalogProvider[] };
        setCatalogProviders(payload.providers.sort((a, b) => a.id.localeCompare(b.id)));
        setIsLoadingCatalog(false);
      }
    };

    const handleProviderModels = (msg: WSServerMessage) => {
      if (msg.type === 'provider.models') {
        const payload = msg.payload as { provider: string; models: CatalogModel[] };
        setCatalogModels((prev) => ({ ...prev, [payload.provider]: payload.models }));
        setIsLoadingModels(false);
      }
    };

    const handleSavedProviders = (msg: WSServerMessage) => {
      if (msg.type === 'providers.saved') {
        const payload = msg.payload as { providers: SavedProvider[] };
        const next = payload.providers.sort((a, b) => a.id.localeCompare(b.id));
        setSavedProviders(next);
        setIsLoadingSaved(false);
        if (next.length > 0) setProviderTab('saved');
      }
    };

    if (!wsConnected || !wsClient) return;

    const off1 = wsClient.on('provider.catalog', handleProviderCatalog);
    const off2 = wsClient.on('provider.models', handleProviderModels);
    const off3 = wsClient.on('providers.saved', handleSavedProviders);

    setIsLoadingCatalog(true);
    setIsLoadingSaved(true);
    wsClient.listProviders();
    wsClient.listSavedProviders();

    return () => {
      off1?.();
      off2?.();
      off3?.();
    };
  }, [wsConnected, wsClient]);

  // Provider selection
  const handleProviderSelect = useCallback(
    (providerId: string) => {
      setProvider(providerId);
      if (!catalogModels[providerId]) {
        setIsLoadingModels(true);
        ws.listProviderModels?.(providerId);
      }
    },
    [catalogModels, setProvider, ws],
  );

  // Model selection. The switch is fire-and-forget on the socket but the
  // server always acks with `key.operation_result` — only toast success once
  // it lands, so a rejected switch doesn't read as succeeded.
  const handleModelSelect = useCallback(
    (modelId: string) => {
      setModel(modelId);
      const currentProvider = useConfigStore.getState().provider;
      if (wsClient) {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const off = wsClient.on('key.operation_result', (msg: WSServerMessage) => {
          if (timer) clearTimeout(timer);
          off();
          const p = (msg as { payload: { success: boolean; message: string } }).payload;
          if (p.success) {
            toast.success(
              i18n.t('settings:toast.switchingTo', { provider: currentProvider, model: modelId }),
            );
          } else {
            toast.error(p.message);
          }
        });
        timer = setTimeout(off, 8000);
      }
      ws.switchModel?.(currentProvider, modelId);
    },
    [setModel, ws, wsClient],
  );

  // Key management callbacks
  const handleAddKey = useCallback(
    (providerId: string, label: string, value: string) => {
      ws.addKey?.(providerId, label, value);
    },
    [ws],
  );

  const handleDeleteKey = useCallback(
    (providerId: string, label: string) => {
      ws.deleteKey?.(providerId, label);
    },
    [ws],
  );

  const handleSetActiveKey = useCallback(
    (providerId: string, label: string) => {
      ws.setActiveKey?.(providerId, label);
    },
    [ws],
  );

  const handleAddProvider = useCallback(
    (id: string, family: string, baseUrl?: string | undefined, apiKey?: string) => {
      ws.addProvider?.(id, family, baseUrl, apiKey);
    },
    [ws],
  );

  const handleRemoveProvider = useCallback(
    (providerId: string) => {
      ws.removeProvider?.(providerId);
    },
    [ws],
  );

  const handlePickProviderModel = useCallback(
    (providerId: string, modelId: string) => {
      ws.client.updateProvider({ id: providerId, models: [modelId] });
      if (providerId === useConfigStore.getState().provider) {
        setModel(modelId);
      }
    },
    [setModel, ws.client],
  );

  const setFallbackProfiles = useCallback(
    (next: Record<string, string[]>) => syncPref('fallbackProfiles', next),
    [syncPref],
  );

  const addFallbackProfile = useCallback(() => {
    const name = newFallbackProfileName.trim();
    if (!name) return;
    if (localPrefs.fallbackProfiles[name]) {
      toast.error(i18n.t('settings:toast.fallbackExists', { name }));
      return;
    }
    setFallbackProfiles({ ...localPrefs.fallbackProfiles, [name]: [] });
    setNewFallbackProfileName('');
  }, [localPrefs.fallbackProfiles, newFallbackProfileName, setFallbackProfiles]);

  const createDefaultFallbackProfile = useCallback(() => {
    const primary = provider && activeModel ? `${provider}/${activeModel}` : '';
    if (!primary) {
      toast.error(i18n.t('settings:toast.selectProviderModelFirst'));
      return;
    }
    const chain = [primary, ...localPrefs.fallbackModels].filter(
      (ref, index, arr) => ref && arr.indexOf(ref) === index,
    );
    setFallbackProfiles({ ...localPrefs.fallbackProfiles, default: chain });
    toast.success(i18n.t('settings:toast.defaultProfileCreated'));
  }, [
    activeModel,
    localPrefs.fallbackModels,
    localPrefs.fallbackProfiles,
    provider,
    setFallbackProfiles,
  ]);

  useEffect(() => {
    if (Object.keys(localPrefs.fallbackProfiles).length > 0) return;
    const primary = provider && activeModel ? `${provider}/${activeModel}` : '';
    if (!primary) return;
    const chain = [primary, ...localPrefs.fallbackModels].filter(
      (ref, index, arr) => ref && arr.indexOf(ref) === index,
    );
    setFallbackProfiles({ default: chain });
  }, [
    activeModel,
    localPrefs.fallbackModels,
    localPrefs.fallbackProfiles,
    provider,
    setFallbackProfiles,
  ]);

  const updateFallbackProfile = useCallback(
    (name: string, chain: string[]) => {
      setFallbackProfiles({ ...localPrefs.fallbackProfiles, [name]: chain });
    },
    [localPrefs.fallbackProfiles, setFallbackProfiles],
  );

  const removeFallbackProfile = useCallback(
    (name: string) => {
      const { [name]: _removed, ...rest } = localPrefs.fallbackProfiles;
      setFallbackProfiles(rest);
    },
    [localPrefs.fallbackProfiles, setFallbackProfiles],
  );

  const useFallbackProfileAsActive = useCallback(
    (name: string) => {
      const chain = localPrefs.fallbackProfiles[name] ?? [];
      syncPref('fallbackModels', chain);
    },
    [localPrefs.fallbackProfiles, syncPref],
  );

  const setLeaderFromFallbackProfile = useCallback(
    (name: string) => {
      const chain = localPrefs.fallbackProfiles[name] ?? [];
      const first = chain[0];
      if (!first) {
        toast.error(i18n.t('settings:toast.profileEmpty', { name }));
        return;
      }
      const slash = first.indexOf('/');
      const targetProvider = slash > 0 ? first.slice(0, slash) : provider;
      const targetModel = slash > 0 ? first.slice(slash + 1) : first;
      setProvider(targetProvider);
      setModel(targetModel);
      ws.switchModel?.(targetProvider, targetModel);
      syncPref('fallbackModels', chain.slice(1));
      toast.success(i18n.t('settings:toast.leaderSetFrom', { name }));
    },
    [localPrefs.fallbackProfiles, provider, setModel, setProvider, syncPref, ws],
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background/70">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-border/70 bg-card/90 backdrop-blur-xl shrink-0 shadow-sm">
        <div>
          <h1 className="text-lg font-semibold">{t('settings:title')}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {provider && activeModel ? `${provider} / ${activeModel}` : t('settings:tabs.provider')}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => showPanel('chat')}>
          <X className="h-4 w-4" />
        </Button>
      </header>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1" ref={scrollAreaRef as React.Ref<HTMLDivElement>}>
        <div className="mx-auto max-w-6xl p-4 sm:p-6">
          <Tabs
            value={settingsActiveTab}
            onValueChange={setSettingsActiveTab}
            className="grid min-h-[calc(100dvh-9rem)] gap-3 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-5"
          >
            <div className="relative min-w-0">
              <TabsList className="flex h-auto w-full justify-start gap-1 overflow-x-scroll rounded-lg border border-border/70 bg-card/60 p-1 pb-2 shadow-sm [scrollbar-gutter:stable] lg:sticky lg:top-4 lg:flex-col lg:overflow-visible lg:rounded-xl lg:bg-card/65 lg:p-2">
                <TabsTrigger
                  value="provider"
                  className="h-9 shrink-0 gap-2 rounded-md px-3 text-xs scroll-mt-2 lg:w-full lg:justify-start"
                >
                  <Network className="h-3.5 w-3.5" />
                  {t('settings:tabs.provider')}
                </TabsTrigger>
                <TabsTrigger
                  value="connection"
                  className="h-9 shrink-0 gap-2 rounded-md px-3 text-xs scroll-mt-2 lg:w-full lg:justify-start"
                >
                  <Globe className="h-3.5 w-3.5" />
                  {t('settings:tabs.connection')}
                </TabsTrigger>
                <TabsTrigger
                  value="appearance"
                  className="h-9 shrink-0 gap-2 rounded-md px-3 text-xs scroll-mt-2 lg:w-full lg:justify-start"
                >
                  <Palette className="h-3.5 w-3.5" />
                  {t('settings:tabs.appearance')}
                </TabsTrigger>
                <TabsTrigger
                  value="agent"
                  className="h-9 shrink-0 gap-2 rounded-md px-3 text-xs scroll-mt-2 lg:w-full lg:justify-start"
                >
                  <Bot className="h-3.5 w-3.5" />
                  {t('settings:tabs.agent')}
                </TabsTrigger>
                <TabsTrigger
                  value="features"
                  className="h-9 shrink-0 gap-2 rounded-md px-3 text-xs scroll-mt-2 lg:w-full lg:justify-start"
                >
                  <Puzzle className="h-3.5 w-3.5" />
                  {t('settings:tabs.features')}
                </TabsTrigger>
                <TabsTrigger
                  value="tools"
                  className="h-9 shrink-0 gap-2 rounded-md px-3 text-xs scroll-mt-2 lg:w-full lg:justify-start"
                >
                  <Wrench className="h-3.5 w-3.5" />
                  {t('settings:tabs.tools')}
                </TabsTrigger>
                <TabsTrigger
                  value="mcp"
                  className="h-9 shrink-0 gap-2 rounded-md px-3 text-xs scroll-mt-2 lg:w-full lg:justify-start"
                >
                  <Server className="h-3.5 w-3.5" />
                  {t('settings:tabs.mcp')}
                </TabsTrigger>
                <TabsTrigger
                  value="brain"
                  className="h-9 shrink-0 gap-2 rounded-md px-3 text-xs scroll-mt-2 lg:w-full lg:justify-start"
                >
                  <Brain className="h-3.5 w-3.5" />
                  {t('settings:tabs.brain')}
                </TabsTrigger>
                <TabsTrigger
                  value="shadow"
                  className="h-9 shrink-0 gap-2 rounded-md px-3 text-xs scroll-mt-2 lg:w-full lg:justify-start"
                >
                  <Eye className="h-3.5 w-3.5" />
                  {t('settings:tabs.shadow')}
                </TabsTrigger>
              </TabsList>
              <div className="pointer-events-none absolute inset-y-1 left-0 z-10 w-8 rounded-l-lg bg-gradient-to-r from-background via-background/90 to-transparent lg:hidden" />
              <div className="pointer-events-none absolute inset-y-1 right-0 z-10 w-8 rounded-r-lg bg-gradient-to-l from-background via-background/90 to-transparent lg:hidden" />
            </div>

            <div className="min-w-0 rounded-xl border border-border/70 bg-card/75 p-4 shadow-sm sm:p-5">
              {/* Provider & Model Tab — pick a provider, then its model */}
              <TabsContent value="provider" className="mt-0 space-y-4">
                <ProviderSection
                  activeProvider={provider}
                  catalogProviders={catalogProviders}
                  isLoadingCatalog={isLoadingCatalog}
                  savedProviders={savedProviders}
                  isLoadingSaved={isLoadingSaved}
                  providerTab={providerTab}
                  setProviderTab={setProviderTab}
                  onSelectProvider={handleProviderSelect}
                  onAddKey={handleAddKey}
                  onDeleteKey={handleDeleteKey}
                  onSetActiveKey={handleSetActiveKey}
                  onAddProvider={handleAddProvider}
                  onRemoveProvider={handleRemoveProvider}
                  onPickProviderModel={handlePickProviderModel}
                  ws={ws.client}
                  catalogQuery={catalogQuery}
                  setCatalogQuery={setCatalogQuery}
                />
                <div className="pt-4 border-t">
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-muted-foreground" />
                    {t('settings:agent.modelHeading')}
                  </h3>
                  <ModelSection
                    provider={provider}
                    catalogModels={catalogModels}
                    currentCatalogProvider={currentCatalogProvider}
                    isLoadingModels={isLoadingModels}
                    setIsLoadingModels={setIsLoadingModels}
                    onModelSelect={handleModelSelect}
                    refreshModels={(pid) => ws.listProviderModels?.(pid)}
                  />
                </div>
              </TabsContent>

              <ConnectionSettingsTab />
              <AppearanceSettingsTab />

              {/* Agent Tab */}
              <TabsContent value="agent" className="mt-0 space-y-4">
                <div>
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Activity className="h-4 w-4 text-muted-foreground" />
                    {t('settings:agent.autonomyHeading')}
                  </h3>
                  <PreferenceSelect
                    label={t('settings:agent.autonomyModeLabel')}
                    hint={t('settings:agent.autonomyModeHint')}
                    value={localPrefs.autonomy}
                    options={[
                      { value: 'off' as const, label: t('settings:agent.autonomyModeOff') },
                      { value: 'suggest' as const, label: t('settings:agent.autonomyModeSuggest') },
                      { value: 'auto' as const, label: t('settings:agent.autonomyModeAuto') },
                      { value: 'eternal' as const, label: t('settings:agent.autonomyModeEternal') },
                      {
                        value: 'eternal-parallel' as const,
                        label: t('settings:agent.autonomyModeEternalParallel'),
                      },
                    ]}
                    onChange={(v) => {
                      localPrefs.set({ autonomy: v });
                      switchAutonomy(v);
                    }}
                  />
                  <PreferenceSlider
                    label={t('settings:agent.autoProceedDelayLabel')}
                    hint={t('settings:agent.autoProceedDelayHint')}
                    value={localPrefs.autonomyDelayMs}
                    min={0}
                    max={10000}
                    step={500}
                    unit="ms"
                    onChange={(v) => syncPref('autonomyDelayMs', v)}
                  />
                  <PreferenceToggle
                    label={t('settings:agent.yoloLabel')}
                    hint={t('settings:agent.yoloHint')}
                    value={localPrefs.yolo}
                    onChange={() => syncPref('yolo', !localPrefs.yolo)}
                  />
                </div>

                <div className="pt-2 border-t">
                  <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                    <Zap className="h-4 w-4 text-muted-foreground" />
                    {t('settings:agent.refineHeading')}
                  </h3>
                  <PreferenceToggle
                    label={t('settings:agent.enableRefineLabel')}
                    hint={t('settings:agent.enableRefineHint')}
                    value={localPrefs.enhanceEnabled}
                    onChange={() => syncPref('enhanceEnabled', !localPrefs.enhanceEnabled)}
                  />
                  <PreferenceSlider
                    label={t('settings:agent.refineDelayLabel')}
                    hint={t('settings:agent.refineDelayHint')}
                    value={localPrefs.enhanceDelayMs}
                    min={30000}
                    max={120000}
                    step={15000}
                    unit="ms"
                    onChange={(v) => syncPref('enhanceDelayMs', v)}
                  />
                  <PreferenceSelect
                    label={t('settings:agent.refineLanguageLabel')}
                    hint={t('settings:agent.refineLanguageHint')}
                    value={localPrefs.enhanceLanguage}
                    options={[
                      {
                        value: 'original' as const,
                        label: t('settings:agent.refineLanguageOriginal'),
                      },
                      {
                        value: 'english' as const,
                        label: t('settings:agent.refineLanguageEnglish'),
                      },
                    ]}
                    onChange={(v) => syncPref('enhanceLanguage', v)}
                  />

                  {/* ── Refiner config — unified selector ── */}
                  <div className="pt-2">
                    <p className="text-sm font-medium mb-1">{t('settings:agent.refineHeading')}</p>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-3 rounded-lg border border-border p-3 text-left cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => setRefinerPickerOpen(true)}
                    >
                      <div className="min-w-0 flex-1">
                        {localPrefs.refinerFallbackProfile ? (
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                              {localPrefs.refinerFallbackProfile}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {(
                                localPrefs.fallbackProfiles[localPrefs.refinerFallbackProfile] ?? []
                              )
                                .slice(0, 2)
                                .join(' → ')}
                              {(
                                localPrefs.fallbackProfiles[localPrefs.refinerFallbackProfile] ?? []
                              ).length > 2
                                ? ' …'
                                : ''}
                            </span>
                          </div>
                        ) : localPrefs.refinerProvider && localPrefs.refinerModel ? (
                          <span className="text-xs font-mono">
                            {localPrefs.refinerProvider}/{localPrefs.refinerModel}
                          </span>
                        ) : localPrefs.refinerProvider ? (
                          <span className="text-xs font-mono">
                            {localPrefs.refinerProvider} /{' '}
                            <span className="text-muted-foreground">(session model)</span>
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {t('settings:agent.refinerProviderDefault')}
                          </span>
                        )}
                      </div>
                      <Cpu className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </button>
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('settings:agent.refineDelayHint')}
                    </p>
                  </div>

                  {/* Unified picker dialog */}
                  {refinerPickerOpen && (
                    <ModelSelectDialog
                      open={refinerPickerOpen}
                      mode="both"
                      title={t('settings:agent.refineHeading')}
                      hint={t('settings:agent.refinerProviderHint')}
                      fallbackProfiles={localPrefs.fallbackProfiles}
                      clearLabel={t('common:action.clear')}
                      onPick={(result) => {
                        if (result.type === 'clear') {
                          syncPref('refinerProvider', '');
                          syncPref('refinerModel', '');
                          syncPref('refinerFallbackProfile', '');
                        } else if (result.type === 'provider-model') {
                          syncPref('refinerProvider', result.provider);
                          syncPref('refinerModel', result.model);
                          syncPref('refinerFallbackProfile', '');
                        } else if (result.type === 'fallback-profile') {
                          syncPref('refinerProvider', '');
                          syncPref('refinerModel', '');
                          syncPref('refinerFallbackProfile', result.name);
                        }
                        setRefinerPickerOpen(false);
                      }}
                      onClose={() => setRefinerPickerOpen(false)}
                    />
                  )}
                </div>

                <div className="pt-2 border-t">
                  <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-muted-foreground" />
                    {t('settings:agent.reasoningHeading')}
                  </h3>
                  <PreferenceSelect
                    label={t('settings:agent.reasoningModeLabel')}
                    hint={t('settings:agent.reasoningModeHint')}
                    value={localPrefs.reasoningMode}
                    options={[
                      { value: 'auto' as const, label: t('settings:agent.reasoningModeAuto') },
                      { value: 'on' as const, label: t('settings:agent.reasoningModeOn') },
                      { value: 'off' as const, label: t('settings:agent.reasoningModeOff') },
                    ]}
                    onChange={(v) => syncPref('reasoningMode', v)}
                  />
                  <PreferenceSelect
                    label={t('settings:agent.reasoningEffortLabel')}
                    hint={t('settings:agent.reasoningEffortHint')}
                    value={localPrefs.reasoningEffort}
                    options={[
                      { value: 'none' as const, label: t('settings:agent.reasoningEffortNone') },
                      {
                        value: 'minimal' as const,
                        label: t('settings:agent.reasoningEffortMinimal'),
                      },
                      { value: 'low' as const, label: t('settings:agent.reasoningEffortLow') },
                      {
                        value: 'medium' as const,
                        label: t('settings:agent.reasoningEffortMedium'),
                      },
                      { value: 'high' as const, label: t('settings:agent.reasoningEffortHigh') },
                      { value: 'xhigh' as const, label: t('settings:agent.reasoningEffortXhigh') },
                      { value: 'max' as const, label: t('settings:agent.reasoningEffortMax') },
                    ]}
                    onChange={(v) => syncPref('reasoningEffort', v)}
                  />
                  <PreferenceToggle
                    label={t('settings:agent.preserveThinkingLabel')}
                    hint={t('settings:agent.preserveThinkingHint')}
                    value={localPrefs.reasoningPreserve}
                    onChange={() => syncPref('reasoningPreserve', !localPrefs.reasoningPreserve)}
                  />
                  <PreferenceSelect
                    label={t('settings:agent.cacheTtlLabel')}
                    hint={t('settings:agent.cacheTtlHint')}
                    value={localPrefs.cacheTtl}
                    options={[
                      { value: 'default' as const, label: t('settings:agent.cacheTtlDefault') },
                      { value: '5m' as const, label: t('settings:agent.cacheTtl5m') },
                      { value: '1h' as const, label: t('settings:agent.cacheTtl1h') },
                    ]}
                    onChange={(v) => syncPref('cacheTtl', v)}
                  />
                  <p className="text-xs text-muted-foreground mt-2">
                    {t('settings:agent.capsHint')}
                  </p>
                </div>

                <div className="pt-2 border-t">
                  <h3 className="text-sm font-semibold mb-2 mt-3">
                    Provider/model availability calendar
                  </h3>
                  <p className="mb-3 text-xs text-muted-foreground">
                    Prevent autonomous and overnight runs from using selected providers or models
                    during recurring windows.
                  </p>
                  <AvailabilityCalendarEditor
                    value={localPrefs.modelAvailabilitySchedule}
                    candidates={fallbackCandidates}
                    onChange={(next) => syncPref('modelAvailabilitySchedule', next)}
                  />
                </div>

                <div className="pt-2 border-t">
                  <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-muted-foreground" />
                    {t('settings:agent.fallbackHeading')}
                  </h3>
                  <p className="mb-2 text-xs text-muted-foreground">
                    {t('settings:agent.fallbackBody')}
                  </p>
                  <FallbackEditor
                    value={localPrefs.fallbackModels}
                    candidates={fallbackCandidates}
                    onChange={(next) => syncPref('fallbackModels', next)}
                  />
                  <div className="pt-1">
                    <PreferenceToggle
                      label={t('settings:agent.autoFallbackLabel')}
                      hint={t('settings:agent.autoFallbackHint')}
                      value={localPrefs.fallbackAuto}
                      onChange={() => syncPref('fallbackAuto', !localPrefs.fallbackAuto)}
                    />
                    <PreferenceToggle
                      label={t('settings:agent.favoritesOnlyLabel')}
                      hint={t('settings:agent.favoritesOnlyHint')}
                      value={localPrefs.favoriteModelsOnly}
                      onChange={() =>
                        syncPref('favoriteModelsOnly', !localPrefs.favoriteModelsOnly)
                      }
                    />
                  </div>
                </div>

                <div className="pt-2 border-t">
                  <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                    <ListPlus className="h-4 w-4 text-muted-foreground" />
                    {t('settings:agent.profilesHeading')}
                  </h3>
                  <div className="flex gap-2">
                    <Input
                      value={newFallbackProfileName}
                      onChange={(e) => setNewFallbackProfileName(e.target.value)}
                      placeholder="fallback1"
                      className="font-mono text-sm"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addFallbackProfile();
                      }}
                    />
                    <Button type="button" variant="outline" onClick={addFallbackProfile}>
                      {t('settings:agent.addProfile')}
                    </Button>
                  </div>
                  <div className="mt-3 space-y-3">
                    {Object.keys(localPrefs.fallbackProfiles).length === 0 ? (
                      <div className="rounded-md border border-dashed border-border p-3">
                        <p className="text-xs text-muted-foreground">
                          {t('settings:agent.noProfiles')}
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="mt-2"
                          onClick={createDefaultFallbackProfile}
                        >
                          {t('settings:agent.createDefault')}
                        </Button>
                      </div>
                    ) : (
                      Object.entries(localPrefs.fallbackProfiles)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([name, chain]) => (
                          <div key={name} className="rounded-md border border-border p-3">
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <span className="font-mono text-sm font-medium">{name}</span>
                              <div className="flex gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => useFallbackProfileAsActive(name)}
                                >
                                  {t('settings:agent.useChain')}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setLeaderFromFallbackProfile(name)}
                                >
                                  {t('settings:agent.setLeader')}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => removeFallbackProfile(name)}
                                >
                                  {t('common:action.remove')}
                                </Button>
                              </div>
                            </div>
                            <FallbackEditor
                              value={chain}
                              candidates={fallbackCandidates}
                              placeholder={t('settings:agent.addModelToProfile')}
                              emptyHint={t('settings:agent.profileEmpty')}
                              onChange={(next) => updateFallbackProfile(name, next)}
                            />
                          </div>
                        ))
                    )}
                  </div>
                </div>

                <div className="pt-2 border-t">
                  <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-muted-foreground" />
                    {t('settings:agent.favoritesHeading')}
                  </h3>
                  <FallbackEditor
                    value={localPrefs.favoriteModels}
                    candidates={fallbackCandidates}
                    placeholder={t('settings:agent.addFavoriteModel')}
                    emptyHint={t('settings:agent.favoritesEmpty')}
                    onChange={(next) => syncPref('favoriteModels', next)}
                  />
                </div>

                <RoutingSection syncPref={syncPref} candidates={fallbackCandidates} />

                <div className="pt-2 border-t">
                  <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                    <Network className="h-4 w-4 text-muted-foreground" />
                    {t('settings:agent.hqHeading')}
                  </h3>
                  <PreferenceToggle
                    label={t('settings:agent.hqPublishingLabel')}
                    hint={t('settings:agent.hqPublishingHint')}
                    value={localPrefs.hqEnabled}
                    onChange={() => syncPref('hqEnabled', !localPrefs.hqEnabled)}
                  />
                  <div className="space-y-1 py-2">
                    <span className="text-sm font-medium">{t('settings:agent.hqUrlLabel')}</span>
                    <Input
                      value={localPrefs.hqUrl}
                      placeholder="http://host:3499"
                      onChange={(e) => syncPref('hqUrl', e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">{t('settings:agent.hqUrlHint')}</p>
                  </div>
                  <div className="space-y-1 py-2">
                    <span className="text-sm font-medium">{t('settings:agent.hqTokenLabel')}</span>
                    <Input
                      type="password"
                      value={localPrefs.hqToken}
                      placeholder="Client token from wstack --hq"
                      onChange={(e) => syncPref('hqToken', e.target.value)}
                    />
                  </div>
                  <PreferenceToggle
                    label={t('settings:agent.hqRawContentLabel')}
                    hint={t('settings:agent.hqRawContentHint')}
                    value={localPrefs.hqRawContent}
                    onChange={() => syncPref('hqRawContent', !localPrefs.hqRawContent)}
                  />
                </div>

                <div className="pt-2 border-t">
                  <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                    <Zap className="h-4 w-4 text-muted-foreground" />
                    {t('settings:agent.executionHeading')}
                  </h3>
                  <PreferenceSlider
                    label={t('settings:agent.maxIterationsLabel')}
                    hint={t('settings:agent.maxIterationsHint')}
                    value={localPrefs.maxIterations}
                    min={10}
                    max={2000}
                    step={10}
                    onChange={(v) => syncPref('maxIterations', v)}
                  />
                  <PreferenceSlider
                    label={t('settings:agent.autoProceedMaxIterationsLabel')}
                    hint={t('settings:agent.autoProceedMaxIterationsHint')}
                    value={localPrefs.autoProceedMaxIterations}
                    min={0}
                    max={250}
                    step={5}
                    onChange={(v) => syncPref('autoProceedMaxIterations', v)}
                  />
                  <PreferenceToggle
                    label={t('settings:agent.confirmExitLabel')}
                    hint={t('settings:agent.confirmExitHint')}
                    value={localPrefs.confirmExit}
                    onChange={() => syncPref('confirmExit', !localPrefs.confirmExit)}
                  />
                  <PreferenceToggle
                    label={t('settings:agent.chimeLabel')}
                    hint={t('settings:agent.chimeHint')}
                    value={localPrefs.chime}
                    onChange={() => syncPref('chime', !localPrefs.chime)}
                  />
                </div>

                <div className="pt-2 border-t">
                  <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                    <Layers className="h-4 w-4 text-muted-foreground" />
                    {t('settings:agent.fleetHeading')}
                  </h3>
                  <PreferenceToggle
                    label={t('settings:agent.fleetChatVerbosityLabel')}
                    hint={t('settings:agent.fleetChatVerbosityHint')}
                    value={localPrefs.fleetChatVerbosity !== 'off'}
                    onChange={() => syncPref('fleetChatVerbosity', localPrefs.fleetChatVerbosity === 'off' ? 'full' : 'off')}
                  />
                  <PreferenceSlider
                    label={t('settings:agent.maxConcurrentLabel')}
                    hint={t('settings:agent.maxConcurrentHint')}
                    value={localPrefs.maxConcurrent}
                    min={1}
                    max={50}
                    step={1}
                    onChange={(v) => syncPref('maxConcurrent', v)}
                  />
                  <PreferenceToggle
                    label={t('settings:agent.nextPredictionLabel')}
                    hint={t('settings:agent.nextPredictionHint')}
                    value={localPrefs.nextPrediction}
                    onChange={() => syncPref('nextPrediction', !localPrefs.nextPrediction)}
                  />
                </div>

                {/* Telegram notifications — mirrors the CLI /telegram-settings
                  toggles. Configured flag gates the whole section so users
                  without a bot token aren't shown dead controls. */}
                <div className="pt-2 border-t">
                  <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                    <Send className="h-4 w-4 text-muted-foreground" />
                    {t('settings:agent.telegramHeading')}
                  </h3>
                  {localPrefs.tgConfigured ? (
                    <>
                      <PreferenceToggle
                        label={t('settings:agent.telegramSessionEndLabel')}
                        hint={t('settings:agent.telegramSessionEndHint')}
                        value={localPrefs.tgSessionEnd}
                        onChange={() => syncPref('tgSessionEnd', !localPrefs.tgSessionEnd)}
                      />
                      <PreferenceToggle
                        label={t('settings:agent.telegramDelegateLabel')}
                        hint={t('settings:agent.telegramDelegateHint')}
                        value={localPrefs.tgDelegate}
                        onChange={() => syncPref('tgDelegate', !localPrefs.tgDelegate)}
                      />
                      <PreferenceToggle
                        label={t('settings:agent.telegramLongToolLabel')}
                        hint={t('settings:agent.telegramLongToolHint', {
                          ms: localPrefs.tgLongToolMs,
                        })}
                        value={localPrefs.tgLongToolMs > 0}
                        onChange={() =>
                          syncPref('tgLongToolMs', localPrefs.tgLongToolMs > 0 ? 0 : 30_000)
                        }
                      />
                      <p className="text-xs text-muted-foreground mt-2">
                        {t('settings:agent.telegramChangesApply')}
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {t('settings:agent.telegramNotConfigured')}
                    </p>
                  )}
                </div>
              </TabsContent>

              {/* Features Tab */}
              <TabsContent value="features" className="mt-0 space-y-4">
                <div>
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Puzzle className="h-4 w-4 text-muted-foreground" />
                    {t('settings:features.flagsHeading')}
                  </h3>
                  <PreferenceToggle
                    label={t('settings:features.mcpLabel')}
                    hint={t('settings:features.mcpHint')}
                    value={localPrefs.featureMcp}
                    onChange={() => syncPref('featureMcp', !localPrefs.featureMcp)}
                  />
                  <PreferenceToggle
                    label={t('settings:features.pluginsLabel')}
                    hint={t('settings:features.pluginsHint')}
                    value={localPrefs.featurePlugins}
                    onChange={() => syncPref('featurePlugins', !localPrefs.featurePlugins)}
                  />
                  <PreferenceToggle
                    label={t('settings:features.memoryLabel')}
                    hint={t('settings:features.memoryHint')}
                    value={localPrefs.featureMemory}
                    onChange={() => syncPref('featureMemory', !localPrefs.featureMemory)}
                  />
                  <PreferenceToggle
                    label={t('settings:features.skillsLabel')}
                    hint={t('settings:features.skillsHint')}
                    value={localPrefs.featureSkills}
                    onChange={() => syncPref('featureSkills', !localPrefs.featureSkills)}
                  />
                  <PreferenceToggle
                    label={t('settings:features.modelsRegistryLabel')}
                    hint={t('settings:features.modelsRegistryHint')}
                    value={localPrefs.featureModelsRegistry}
                    onChange={() =>
                      syncPref('featureModelsRegistry', !localPrefs.featureModelsRegistry)
                    }
                  />
                  <PreferenceToggle
                    label={t('settings:features.indexOnStartLabel')}
                    hint={t('settings:features.indexOnStartHint')}
                    value={localPrefs.indexOnStart}
                    onChange={() => syncPref('indexOnStart', !localPrefs.indexOnStart)}
                  />
                </div>

                <div className="pt-2 border-t">
                  <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                    <Zap className="h-4 w-4 text-muted-foreground" />
                    {t('settings:features.chimeraHeading')}
                  </h3>
                  {/* Chimera + auto-review settings are exposed by the dedicated
                    ChimeraSettingsPanel below — it surfaces every knob
                    (provider, model, maxFiles, autoFix, fallbackProfile,
                    fallbackModels, debounce, concurrency, cascade, toggles)
                    rather than just the auto-fix mode. */}
                  <p className="text-xs text-muted-foreground">
                    {t('settings:features.chimeraAutoFixHint')}
                  </p>
                </div>

                <div className="pt-2 border-t">
                  <ChimeraSettingsPanel
                    syncPref={syncPref}
                    sessionProvider={provider}
                    sessionModel={activeModel}
                  />
                </div>

                <PluginToggleList />

                <div className="pt-2 border-t">
                  <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    {t('settings:features.contextHeading')}
                  </h3>
                  <PreferenceToggle
                    label={t('settings:features.autoCompactLabel')}
                    hint={t('settings:features.autoCompactHint')}
                    value={localPrefs.contextAutoCompact}
                    onChange={() => syncPref('contextAutoCompact', !localPrefs.contextAutoCompact)}
                  />
                  <PreferenceSelect
                    label={t('settings:features.compactorStrategyLabel')}
                    hint={t('settings:features.compactorStrategyHint')}
                    value={localPrefs.contextStrategy}
                    options={[
                      {
                        value: 'hybrid' as const,
                        label: t('settings:features.compactorStrategyHybrid'),
                      },
                      {
                        value: 'intelligent' as const,
                        label: t('settings:features.compactorStrategyIntelligent'),
                      },
                      {
                        value: 'selective' as const,
                        label: t('settings:features.compactorStrategySelective'),
                      },
                    ]}
                    onChange={(v) => syncPref('contextStrategy', v)}
                  />
                  <PreferenceSelect
                    label={t('settings:features.contextModeLabel')}
                    hint={t('settings:features.contextModeHint')}
                    value={localPrefs.contextMode}
                    options={[
                      {
                        value: 'balanced' as const,
                        label: t('settings:features.contextModeBalanced'),
                      },
                      { value: 'frugal' as const, label: t('settings:features.contextModeFrugal') },
                      { value: 'deep' as const, label: t('settings:features.contextModeDeep') },
                      {
                        value: 'archival' as const,
                        label: t('settings:features.contextModeArchival'),
                      },
                    ]}
                    onChange={(v) => syncPref('contextMode', v)}
                  />
                  <PreferenceSelect
                    label={t('settings:features.tokenSavingLabel')}
                    hint={t('settings:features.tokenSavingHint')}
                    value={localPrefs.tokenSavingTier}
                    options={[
                      { value: 'off' as const, label: t('settings:features.tokenSavingOff') },
                      {
                        value: 'minimal' as const,
                        label: t('settings:features.tokenSavingMinimal'),
                      },
                      { value: 'light' as const, label: t('settings:features.tokenSavingLight') },
                      { value: 'medium' as const, label: t('settings:features.tokenSavingMedium') },
                      {
                        value: 'aggressive' as const,
                        label: t('settings:features.tokenSavingAggressive'),
                      },
                    ]}
                    onChange={(v) => syncPref('tokenSavingTier', v)}
                  />
                  <PreferenceSelect
                    label={t('settings:features.logLevelLabel')}
                    hint={t('settings:features.logLevelHint')}
                    value={localPrefs.logLevel}
                    options={[
                      { value: 'debug' as const, label: t('settings:features.logLevelDebug') },
                      { value: 'info' as const, label: t('settings:features.logLevelInfo') },
                      { value: 'warn' as const, label: t('settings:features.logLevelWarn') },
                      { value: 'error' as const, label: t('settings:features.logLevelError') },
                    ]}
                    onChange={(v) => syncPref('logLevel', v)}
                  />
                  <PreferenceSelect
                    label={t('settings:features.auditLevelLabel')}
                    hint={t('settings:features.auditLevelHint')}
                    value={localPrefs.auditLevel}
                    options={[
                      {
                        value: 'minimal' as const,
                        label: t('settings:features.auditLevelMinimal'),
                      },
                      {
                        value: 'standard' as const,
                        label: t('settings:features.auditLevelStandard'),
                      },
                      { value: 'full' as const, label: t('settings:features.auditLevelFull') },
                    ]}
                    onChange={(v) => syncPref('auditLevel', v)}
                  />
                </div>
              </TabsContent>

              {/* Tools Tab */}
              <TabsContent value="tools" className="mt-0 space-y-4">
                <ToolsSection />
              </TabsContent>

              {/* MCP Servers Tab */}
              <TabsContent value="mcp" className="mt-0 space-y-4">
                {!localPrefs.featureMcp ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Server className="w-10 h-10 mx-auto mb-2 opacity-50" />
                    <p>{t('settings:mcp.disabled')}</p>
                    <p className="text-sm mt-1">{t('settings:mcp.disabledHint')}</p>
                  </div>
                ) : (
                  <MCPSection />
                )}
              </TabsContent>

              {/* Brain Tab — risk ceiling + decision log */}
              <TabsContent value="brain" className="mt-0 space-y-4">
                <BrainSection />
              </TabsContent>

              {/* Shadow Agent Tab — start/stop, status */}
              <TabsContent value="shadow" className="mt-0 space-y-4">
                <ShadowSection />
              </TabsContent>
            </div>
          </Tabs>
        </div>
      </ScrollArea>
    </div>
  );
}
