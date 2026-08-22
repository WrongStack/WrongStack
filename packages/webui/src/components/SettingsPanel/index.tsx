import {
  Activity,
  Bot,
  Brain,
  Bug,
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
import { AgentSettingsTab } from './AgentSettingsTab';
import { AppearanceSettingsTab, ConnectionSettingsTab } from './BasicSettingsTabs';
import { ChimeraSettingsPanel } from './ChimeraSettingsPanel';
import { ContextSettingsTab } from './ContextSettingsTab';
import { DisplaySection } from './DisplaySection';
import { ExecutionSettingsTab } from './ExecutionSettingsTab';
import { FallbacksSection } from './FallbacksSection';
import { FleetSection } from './FleetSection';
import { IntegrationsSection } from './IntegrationsSection';
import { LogsSettingsTab } from './LogsSettingsTab';
import { ModelSection } from './ModelSection';
import {
  type CatalogProvider,
  ProviderSection,
  type ProviderTab,
  type SavedProvider,
} from './ProviderSection';
import { RoutingSection } from './RoutingSection';
import { SecuritySection } from './SecuritySection';

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

  const syncPref = useCallback(
    (key: string, value: unknown) => {
      localPrefs.set({ [key]: value } as Parameters<typeof localPrefs.set>[0]);
      updatePrefs({ [key]: value });
    },
    [localPrefs, updatePrefs],
  );

  const [catalogProviders, setCatalogProviders] = useState<CatalogProvider[]>([]);
  const [catalogModels, setCatalogModels] = useState<Record<string, CatalogModel[]>>({});
  const [savedProviders, setSavedProviders] = useState<SavedProvider[]>([]);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isLoadingSaved, setIsLoadingSaved] = useState(false);
  const [providerTab, setProviderTab] = useState<ProviderTab>('catalog');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [resetOpen, setResetOpen] = useState(false);

  const resetConfirm = useCallback(() => {
    localPrefs.reset();
    setResetOpen(false);
    window.location.reload();
  }, [localPrefs]);
  const currentCatalogProvider = catalogProviders.find((p) => p.id === provider);
  const activeTabDef = TABS.find((tab) => tab.id === settingsActiveTab);

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

              <TabsContent value="general" className="mt-0">
                <AppearanceSettingsTab />
              </TabsContent>

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

              <TabsContent value="connection" className="mt-0">
                <ConnectionSettingsTab />
              </TabsContent>

              <TabsContent value="agent" className="mt-0 space-y-6">
                <AgentSettingsTab syncPref={syncPref} switchAutonomy={switchAutonomy} />
              </TabsContent>

              <TabsContent value="execution" className="mt-0 space-y-6">
                <ExecutionSettingsTab syncPref={syncPref} fallbackCandidates={fallbackCandidates} />
              </TabsContent>

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

              <TabsContent value="routing" className="mt-0">
                <RoutingSection syncPref={syncPref} candidates={fallbackCandidates} />
              </TabsContent>

              <TabsContent value="fleet" className="mt-0">
                <FleetSection syncPref={syncPref} />
              </TabsContent>

              <TabsContent value="integrations" className="mt-0">
                <IntegrationsSection syncPref={syncPref} />
              </TabsContent>

              <TabsContent value="chimera" className="mt-0 space-y-6">
                <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
                  <ChimeraSettingsPanel
                    syncPref={syncPref}
                    sessionProvider={provider}
                    sessionModel={activeModel}
                  />
                </div>
              </TabsContent>

              <TabsContent value="context" className="mt-0 space-y-6">
                <ContextSettingsTab syncPref={syncPref} />
              </TabsContent>

              <TabsContent value="logs" className="mt-0 space-y-6">
                <LogsSettingsTab syncPref={syncPref} />
              </TabsContent>

              <TabsContent value="security" className="mt-0">
                <SecuritySection />
              </TabsContent>

              <TabsContent value="display" className="mt-0">
                <DisplaySection syncPref={syncPref} />
              </TabsContent>
            </div>
          </Tabs>
        </div>
      </ScrollArea>

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
