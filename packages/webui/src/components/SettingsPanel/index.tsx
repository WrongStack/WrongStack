import {
  Activity,
  Bot,
  Brain,
  Bug,
  CalendarClock,
  Cpu,
  FileText,
  Globe,
  Layers,
  ListPlus,
  Network,
  Palette,
  Puzzle,
  Radio,
  Settings2,
  Shield,
  X,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { toast } from '@/components/Toaster';
import { useProviderModels } from '@/hooks/useProviderModels';
import { useScrollPosition } from '@/hooks/useScrollPosition';
import { useWebSocket } from '@/hooks/useWebSocket';
import { i18n, useAppTranslation } from '@/i18n';
import { showPanel } from '@/lib/view-navigation';
import { useConfigStore, useUIStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import type { ProviderCustomModelWire, WSServerMessage } from '@/types';
import { AvailabilityCalendarEditor } from '../AvailabilityCalendarEditor';
import { ModelSelectDialog } from '../ModelSelectDialog';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { ScrollArea } from '../ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { AppearanceSettingsTab, ConnectionSettingsTab } from './BasicSettingsTabs';
import { ChimeraSettingsPanel } from './ChimeraSettingsPanel';
import { DisplaySection } from './DisplaySection';
import { FallbacksSection } from './FallbacksSection';
import { FleetSection } from './FleetSection';
import { IntegrationsSection } from './IntegrationsSection';
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
import { SecuritySection } from './SecuritySection';

// ── Tab definition ─────────────────────────────────────────────────────
interface TabDef {
  id: string;
  icon: React.ReactNode;
  labelKey: string;
  descKey?: string;
}

const TABS: TabDef[] = [
  {
    id: 'general',
    icon: <Palette className="h-3.5 w-3.5" />,
    labelKey: 'settings:tabs.general',
    descKey: 'settings:tabs.generalDesc',
  },
  {
    id: 'provider',
    icon: <Network className="h-3.5 w-3.5" />,
    labelKey: 'settings:tabs.provider',
    descKey: 'settings:tabs.providerDesc',
  },
  {
    id: 'connection',
    icon: <Globe className="h-3.5 w-3.5" />,
    labelKey: 'settings:tabs.connection',
    descKey: 'settings:tabs.connectionDesc',
  },
  {
    id: 'agent',
    icon: <Bot className="h-3.5 w-3.5" />,
    labelKey: 'settings:tabs.agent',
    descKey: 'settings:tabs.agentDesc',
  },
  {
    id: 'execution',
    icon: <Zap className="h-3.5 w-3.5" />,
    labelKey: 'settings:tabs.execution',
    descKey: 'settings:tabs.executionDesc',
  },
  {
    id: 'fallbacks',
    icon: <Layers className="h-3.5 w-3.5" />,
    labelKey: 'settings:tabs.fallbacks',
    descKey: 'settings:tabs.fallbacksDesc',
  },
  {
    id: 'routing',
    icon: <ListPlus className="h-3.5 w-3.5" />,
    labelKey: 'settings:tabs.routing',
    descKey: 'settings:tabs.routingDesc',
  },
  {
    id: 'fleet',
    icon: <Radio className="h-3.5 w-3.5" />,
    labelKey: 'settings:tabs.fleet',
    descKey: 'settings:tabs.fleetDesc',
  },
  {
    id: 'integrations',
    icon: <Puzzle className="h-3.5 w-3.5" />,
    labelKey: 'settings:tabs.integrations',
    descKey: 'settings:tabs.integrationsDesc',
  },
  {
    id: 'chimera',
    icon: <Brain className="h-3.5 w-3.5" />,
    labelKey: 'settings:tabs.chimera',
    descKey: 'settings:tabs.chimeraDesc',
  },
  {
    id: 'context',
    icon: <FileText className="h-3.5 w-3.5" />,
    labelKey: 'settings:tabs.context',
    descKey: 'settings:tabs.contextDesc',
  },
  {
    id: 'logs',
    icon: <Bug className="h-3.5 w-3.5" />,
    labelKey: 'settings:tabs.logs',
    descKey: 'settings:tabs.logsDesc',
  },
  {
    id: 'security',
    icon: <Shield className="h-3.5 w-3.5" />,
    labelKey: 'settings:tabs.security',
    descKey: 'settings:tabs.securityDesc',
  },
  {
    id: 'display',
    icon: <Palette className="h-3.5 w-3.5" />,
    labelKey: 'settings:tabs.display',
    descKey: 'settings:tabs.displayDesc',
  },
];

// ── Catalog types ──────────────────────────────────────────────────────
interface CatalogModel {
  id: string;
  name: string;
  releaseDate?: string | undefined;
  contextWindow?: number | undefined;
  inputCost?: number | undefined;
  outputCost?: number | undefined;
  capabilities: string[];
}

// ── Component ──────────────────────────────────────────────────────────

export function SettingsPanel() {
  const { settingsActiveTab, setSettingsActiveTab } = useUIStore(
    useShallow((s) => ({
      settingsActiveTab: s.settingsActiveTab,
      setSettingsActiveTab: s.setSettingsActiveTab,
    })),
  );
  const scrollAreaRef = useScrollPosition<HTMLDivElement>('settings');
  const modelSwitchingRef = useRef(false);
  const [modelSwitching, setModelSwitching] = useState(false);

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
  const fallbackCandidates = useProviderModels(true);

  // Helper: apply a pref change locally AND push it to the server.
  const syncPref = useCallback(
    (key: string, value: unknown) => {
      localPrefs.set({ [key]: value } as Parameters<typeof localPrefs.set>[0]);
      updatePrefs({ [key]: value });
    },
    [localPrefs, updatePrefs],
  );

  // ── Catalog state ──────────────────────────────────────────────────
  const [catalogProviders, setCatalogProviders] = useState<CatalogProvider[]>([]);
  const [catalogModels, setCatalogModels] = useState<Record<string, CatalogModel[]>>({});
  const [savedProviders, setSavedProviders] = useState<SavedProvider[]>([]);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isLoadingSaved, setIsLoadingSaved] = useState(false);
  const [providerTab, setProviderTab] = useState<ProviderTab>('catalog');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [refinerPickerOpen, setRefinerPickerOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  const resetConfirm = useCallback(() => {
    localPrefs.reset();
    setResetOpen(false);
    window.location.reload();
  }, [localPrefs]);
  const currentCatalogProvider = catalogProviders.find((p) => p.id === provider);
  const activeTabDef = TABS.find((tab) => tab.id === settingsActiveTab);

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

  // Model selection
  const handleModelSelect = useCallback(
    async (modelId: string) => {
      if (modelSwitchingRef.current) return;
      const prevModel = useConfigStore.getState().model;
      const currentProvider = useConfigStore.getState().provider;
      if (!currentProvider || modelId === prevModel) return;
      modelSwitchingRef.current = true;
      setModelSwitching(true);
      setModel(modelId);
      try {
        toast.info(
          i18n.t('settings:toast.switchingTo', { provider: currentProvider, model: modelId }),
        );
        const result = await ws.switchModel?.(currentProvider, modelId);
        if (!result?.success) {
          setModel(prevModel);
          toast.error(result?.message ?? i18n.t('settings:toast.modelSwitchTimeout'));
        } else {
          toast.success(
            i18n.t(
              result.runActive
                ? 'settings:toast.modelSwitchedRunActive'
                : 'settings:toast.modelSwitchedNextRequest',
              { from: `${currentProvider} / ${prevModel}`, to: `${currentProvider} / ${modelId}` },
            ),
          );
        }
      } finally {
        modelSwitchingRef.current = false;
        setModelSwitching(false);
      }
    },
    [setModel, ws],
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
    (
      id: string,
      family: string,
      baseUrl?: string | undefined,
      apiKey?: string,
      models?: string[] | undefined,
      customModels?: Record<string, ProviderCustomModelWire> | undefined,
    ) => {
      ws.addProvider?.(id, family, baseUrl, apiKey, models, customModels);
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

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-gradient-to-b from-background/90 via-background/60 to-background/80">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-border/60 bg-card/60 backdrop-blur-xl shrink-0 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Settings2 className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
              {t('settings:title')}
            </h1>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {provider && activeModel ? `${provider} / ${activeModel}` : t('settings:subtitle')}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={() => showPanel('chat')}>
          <X className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setResetOpen(true)}>
          {t('settings:resetLabel')}
        </Button>
      </header>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1" ref={scrollAreaRef}>
        <div className="mx-auto max-w-7xl p-4 sm:p-6">
          <Tabs
            value={settingsActiveTab}
            onValueChange={setSettingsActiveTab}
            className="grid min-h-[calc(100dvh-9rem)] gap-3 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-5"
          >
            <div className="relative min-w-0">
              <TabsList className="flex h-auto w-full justify-start gap-0.5 overflow-x-scroll rounded-lg border border-border/60 bg-card/60 p-1.5 shadow-sm [scrollbar-gutter:stable] lg:sticky lg:top-4 lg:flex-col lg:overflow-visible lg:rounded-xl lg:bg-card/60 lg:p-2">
                {TABS.map((tab) => (
                  <TabsTrigger
                    key={tab.id}
                    value={tab.id}
                    className="h-9 shrink-0 gap-2.5 rounded-md px-3 text-xs scroll-mt-2 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-sm lg:w-full lg:justify-start lg:px-3"
                  >
                    <span className="shrink-0">{tab.icon}</span>
                    <span className="truncate">{t(tab.labelKey)}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
              <div className="pointer-events-none absolute inset-y-1 left-0 z-10 w-8 rounded-l-lg bg-gradient-to-r from-background via-background/90 to-transparent lg:hidden" />
              <div className="pointer-events-none absolute inset-y-1 right-0 z-10 w-8 rounded-r-lg bg-gradient-to-l from-background via-background/90 to-transparent lg:hidden" />
            </div>

            {/* Content area */}
            <div className="min-w-0 space-y-0">
              {activeTabDef?.descKey && (
                <div className="mb-4 flex items-start gap-3 rounded-xl border border-border/60 bg-card/50 px-4 py-3">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                    {activeTabDef.icon}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{t(activeTabDef.labelKey)}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t(activeTabDef.descKey)}
                    </p>
                  </div>
                </div>
              )}

              {/* ═══════════════════════════════════════ General ═══ */}
              <TabsContent value="general" className="mt-0">
                <AppearanceSettingsTab />
              </TabsContent>

              {/* ═══════════════════════════════════════ Provider ═══ */}
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
                <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
                  <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-muted-foreground" />
                    {t('settings:model.heading')}
                  </h3>
                  <ModelSection
                    provider={provider}
                    catalogModels={catalogModels}
                    currentCatalogProvider={currentCatalogProvider}
                    isLoadingModels={isLoadingModels}
                    setIsLoadingModels={setIsLoadingModels}
                    onModelSelect={handleModelSelect}
                    isSwitching={modelSwitching}
                    refreshModels={(pid) => ws.listProviderModels?.(pid)}
                  />
                </div>
              </TabsContent>

              {/* ═══════════════════════════════════════ Connection ═══ */}
              <TabsContent value="connection" className="mt-0">
                <ConnectionSettingsTab />
              </TabsContent>

              {/* ═══════════════════════════════════════ Agent ═══ */}
              <TabsContent value="agent" className="mt-0 space-y-6">
                {/* Autonomy & Behavior */}
                <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
                  <div className="flex items-start gap-3 mb-4">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                      <Activity className="h-5 w-5" />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold">
                        {t('settings:agent.autonomyHeading')}
                      </h3>
                    </div>
                  </div>
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
                    label={t('settings:agent.autonomyDelayMsLabel')}
                    hint={t('settings:agent.autonomyDelayMsHint')}
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

                {/* Prompt Refinement */}
                <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
                  <div className="flex items-start gap-3 mb-4">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                      <Zap className="h-5 w-5" />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold">{t('settings:agent.refineHeading')}</h3>
                    </div>
                  </div>
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
                  <PreferenceSlider
                    label={t('settings:agent.refineCountdownLabel')}
                    hint={t('settings:agent.refineCountdownHint')}
                    value={localPrefs.enhanceCountdownMs}
                    min={1000}
                    max={10000}
                    step={1000}
                    unit="ms"
                    onChange={(v) => syncPref('enhanceCountdownMs', v)}
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

                  {/* Refiner config */}
                  <div className="pt-3">
                    <p className="text-sm font-medium mb-2">{t('settings:agent.refineHeading')}</p>
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
                  </div>

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

                {/* Reasoning & Cache */}
                <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
                  <div className="flex items-start gap-3 mb-4">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                      <Cpu className="h-5 w-5" />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold">
                        {t('settings:agent.reasoningHeading')}
                      </h3>
                    </div>
                  </div>
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
              </TabsContent>

              {/* ═══════════════════════════════════════ Execution ═══ */}
              <TabsContent value="execution" className="mt-0 space-y-6">
                <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
                  <div className="flex items-start gap-3 mb-4">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                      <Zap className="h-5 w-5" />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold">{t('settings:execution.heading')}</h3>
                    </div>
                  </div>
                  <PreferenceSlider
                    label={t('settings:execution.maxIterationsLabel')}
                    hint={t('settings:execution.maxIterationsHint')}
                    value={localPrefs.maxIterations}
                    min={10}
                    max={2000}
                    step={10}
                    onChange={(v) => syncPref('maxIterations', v)}
                  />
                  <PreferenceSlider
                    label={t('settings:execution.autoProceedMaxIterationsLabel')}
                    hint={t('settings:execution.autoProceedMaxIterationsHint')}
                    value={localPrefs.autoProceedMaxIterations}
                    min={0}
                    max={250}
                    step={5}
                    onChange={(v) => syncPref('autoProceedMaxIterations', v)}
                  />
                  <PreferenceToggle
                    label={t('settings:execution.confirmExitLabel')}
                    hint={t('settings:execution.confirmExitHint')}
                    value={localPrefs.confirmExit}
                    onChange={() => syncPref('confirmExit', !localPrefs.confirmExit)}
                  />
                  <PreferenceToggle
                    label={t('settings:execution.chimeLabel')}
                    hint={t('settings:execution.chimeHint')}
                    value={localPrefs.chime}
                    onChange={() => syncPref('chime', !localPrefs.chime)}
                  />
                </div>

                <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
                  <div className="flex items-start gap-3 mb-4">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-warning/20 bg-warning/10 text-warning">
                      <Shield className="h-5 w-5" />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold">
                        {t('settings:execution.breakerLabel')}
                      </h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t('settings:execution.breakerHint')}
                      </p>
                    </div>
                  </div>
                  <PreferenceToggle
                    label={t('settings:execution.breakerLabel')}
                    hint={t('settings:execution.breakerHint')}
                    value={localPrefs.breakerEnabled}
                    onChange={() => syncPref('breakerEnabled', !localPrefs.breakerEnabled)}
                  />
                  <PreferenceSlider
                    label={t('settings:execution.breakerTimeoutLabel')}
                    hint={t('settings:execution.breakerTimeoutHint')}
                    value={localPrefs.breakerAutoKillResetMs}
                    min={0}
                    max={60000}
                    step={1000}
                    unit="ms"
                    onChange={(v) => syncPref('breakerAutoKillResetMs', v)}
                  />
                </div>

                <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
                  <div className="flex items-start gap-3 mb-4">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                      <CalendarClock className="h-5 w-5" />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold">
                        {t('settings:execution.availabilityHeading')}
                      </h3>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t('settings:execution.availabilityHint')}
                      </p>
                    </div>
                  </div>
                  <AvailabilityCalendarEditor
                    value={localPrefs.modelAvailabilitySchedule}
                    candidates={fallbackCandidates}
                    onChange={(next) => syncPref('modelAvailabilitySchedule', next)}
                  />
                </div>
              </TabsContent>

              {/* ═══════════════════════════════════════ Fallbacks ═══ */}
              <TabsContent value="fallbacks" className="mt-0">
                <FallbacksSection
                  syncPref={syncPref}
                  candidates={fallbackCandidates}
                  provider={provider}
                  activeModel={activeModel}
                  setProvider={setProvider}
                  setModel={setModel}
                  switchModel={ws.switchModel}
                />
              </TabsContent>

              {/* ═══════════════════════════════════════ Routing ═══ */}
              <TabsContent value="routing" className="mt-0">
                <RoutingSection syncPref={syncPref} candidates={fallbackCandidates} />
              </TabsContent>

              {/* ═══════════════════════════════════════ Fleet ═══ */}
              <TabsContent value="fleet" className="mt-0">
                <FleetSection syncPref={syncPref} />
              </TabsContent>

              {/* ═══════════════════════════════════════ Integrations ═══ */}
              <TabsContent value="integrations" className="mt-0">
                <IntegrationsSection syncPref={syncPref} />
              </TabsContent>

              {/* ═══════════════════════════════════════ Chimera ═══ */}
              <TabsContent value="chimera" className="mt-0 space-y-6">
                <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
                  <ChimeraSettingsPanel
                    syncPref={syncPref}
                    sessionProvider={provider}
                    sessionModel={activeModel}
                  />
                </div>
              </TabsContent>

              {/* ═══════════════════════════════════════ Context ═══ */}
              <TabsContent value="context" className="mt-0 space-y-6">
                {/* Feature Flags */}
                <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
                  <div className="flex items-start gap-3 mb-4">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                      <FileText className="h-5 w-5" />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold">
                        {t('settings:context.flagsHeading')}
                      </h3>
                    </div>
                  </div>
                  <div className="grid gap-1 sm:grid-cols-2">
                    <PreferenceToggle
                      label={t('settings:context.mcpLabel')}
                      hint={t('settings:context.mcpHint')}
                      value={localPrefs.featureMcp}
                      onChange={() => syncPref('featureMcp', !localPrefs.featureMcp)}
                    />
                    <PreferenceToggle
                      label={t('settings:context.pluginsLabel')}
                      hint={t('settings:context.pluginsHint')}
                      value={localPrefs.featurePlugins}
                      onChange={() => syncPref('featurePlugins', !localPrefs.featurePlugins)}
                    />
                    <PreferenceToggle
                      label={t('settings:context.memoryLabel')}
                      hint={t('settings:context.memoryHint')}
                      value={localPrefs.featureMemory}
                      onChange={() => syncPref('featureMemory', !localPrefs.featureMemory)}
                    />
                    <PreferenceToggle
                      label={t('settings:context.skillsLabel')}
                      hint={t('settings:context.skillsHint')}
                      value={localPrefs.featureSkills}
                      onChange={() => syncPref('featureSkills', !localPrefs.featureSkills)}
                    />
                    <PreferenceToggle
                      label={t('settings:context.modelsRegistryLabel')}
                      hint={t('settings:context.modelsRegistryHint')}
                      value={localPrefs.featureModelsRegistry}
                      onChange={() =>
                        syncPref('featureModelsRegistry', !localPrefs.featureModelsRegistry)
                      }
                    />
                    <PreferenceToggle
                      label={t('settings:context.indexOnStartLabel')}
                      hint={t('settings:context.indexOnStartHint')}
                      value={localPrefs.indexOnStart}
                      onChange={() => syncPref('indexOnStart', !localPrefs.indexOnStart)}
                    />
                  </div>
                </div>

                {/* Context Strategy & Compactor */}
                <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
                  <div className="flex items-start gap-3 mb-4">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                      <FileText className="h-5 w-5" />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold">
                        {t('settings:context.compactorStrategyLabel')}
                      </h3>
                    </div>
                  </div>
                  <PreferenceToggle
                    label={t('settings:context.autoCompactLabel')}
                    hint={t('settings:context.autoCompactHint')}
                    value={localPrefs.contextAutoCompact}
                    onChange={() => syncPref('contextAutoCompact', !localPrefs.contextAutoCompact)}
                  />
                  <PreferenceSelect
                    label={t('settings:context.compactorStrategyLabel')}
                    hint={t('settings:context.compactorStrategyHint')}
                    value={localPrefs.contextStrategy}
                    options={[
                      {
                        value: 'hybrid' as const,
                        label: t('settings:context.compactorStrategyHybrid'),
                      },
                      {
                        value: 'intelligent' as const,
                        label: t('settings:context.compactorStrategyIntelligent'),
                      },
                      {
                        value: 'selective' as const,
                        label: t('settings:context.compactorStrategySelective'),
                      },
                    ]}
                    onChange={(v) => syncPref('contextStrategy', v)}
                  />
                  <PreferenceSelect
                    label={t('settings:context.contextModeLabel')}
                    hint={t('settings:context.contextModeHint')}
                    value={localPrefs.contextMode}
                    options={[
                      {
                        value: 'balanced' as const,
                        label: t('settings:context.contextModeBalanced'),
                      },
                      { value: 'frugal' as const, label: t('settings:context.contextModeFrugal') },
                      { value: 'deep' as const, label: t('settings:context.contextModeDeep') },
                    ]}
                    onChange={(v) => syncPref('contextMode', v)}
                  />
                  <PreferenceSelect
                    label={t('settings:context.tokenSavingLabel')}
                    hint={t('settings:context.tokenSavingHint')}
                    value={localPrefs.tokenSavingTier}
                    options={[
                      { value: 'off' as const, label: t('settings:context.tokenSavingOff') },
                      {
                        value: 'minimal' as const,
                        label: t('settings:context.tokenSavingMinimal'),
                      },
                      { value: 'light' as const, label: t('settings:context.tokenSavingLight') },
                      { value: 'medium' as const, label: t('settings:context.tokenSavingMedium') },
                      {
                        value: 'aggressive' as const,
                        label: t('settings:context.tokenSavingAggressive'),
                      },
                    ]}
                    onChange={(v) => syncPref('tokenSavingTier', v)}
                  />
                </div>

                {/* Per-Plugin Toggle List */}
                <PluginToggleList />
              </TabsContent>

              {/* ═══════════════════════════════════════ Logs ═══ */}
              <TabsContent value="logs" className="mt-0 space-y-6">
                <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
                  <div className="flex items-start gap-3 mb-4">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                      <Bug className="h-5 w-5" />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold">{t('settings:logs.heading')}</h3>
                    </div>
                  </div>
                  <PreferenceSelect
                    label={t('settings:logs.logLevelLabel')}
                    hint={t('settings:logs.logLevelHint')}
                    value={localPrefs.logLevel}
                    options={[
                      { value: 'debug' as const, label: t('settings:logs.logLevelDebug') },
                      { value: 'info' as const, label: t('settings:logs.logLevelInfo') },
                      { value: 'warn' as const, label: t('settings:logs.logLevelWarn') },
                      { value: 'error' as const, label: t('settings:logs.logLevelError') },
                    ]}
                    onChange={(v) => syncPref('logLevel', v)}
                  />
                  <PreferenceSelect
                    label={t('settings:logs.auditLevelLabel')}
                    hint={t('settings:logs.auditLevelHint')}
                    value={localPrefs.auditLevel}
                    options={[
                      { value: 'minimal' as const, label: t('settings:logs.auditLevelMinimal') },
                      { value: 'standard' as const, label: t('settings:logs.auditLevelStandard') },
                      { value: 'full' as const, label: t('settings:logs.auditLevelFull') },
                    ]}
                    onChange={(v) => syncPref('auditLevel', v)}
                  />
                  <PreferenceSelect
                    label={t('settings:logs.fsAccessLabel')}
                    hint={t('settings:logs.fsAccessHint')}
                    value={localPrefs.fsAccess}
                    options={[
                      {
                        value: 'unrestricted' as const,
                        label: t('settings:logs.fsAccessUnrestricted'),
                      },
                      { value: 'project' as const, label: t('settings:logs.fsAccessProject') },
                    ]}
                    onChange={(v) => syncPref('fsAccess', v)}
                  />
                  <PreferenceToggle
                    label={t('settings:logs.debugStreamLabel')}
                    hint={t('settings:logs.debugStreamHint')}
                    value={localPrefs.debugStream}
                    onChange={() => syncPref('debugStream', !localPrefs.debugStream)}
                  />
                </div>
              </TabsContent>

              {/* ═══════════════════════════════════════ Security ═══ */}
              <TabsContent value="security" className="mt-0">
                <SecuritySection />
              </TabsContent>

              {/* ═══════════════════════════════════════ Display ═══ */}
              <TabsContent value="display" className="mt-0">
                <DisplaySection syncPref={syncPref} />
              </TabsContent>
            </div>
          </Tabs>
        </div>
      </ScrollArea>

      {/* Reset confirmation dialog */}
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t('settings:resetConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('settings:resetConfirmBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setResetOpen(false)}>
              {t('settings:cancel')}
            </Button>
            <Button variant="destructive" onClick={resetConfirm}>
              {t('settings:resetConfirmAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
