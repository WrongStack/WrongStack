import {
  Activity,
  Bot,
  Cpu,
  ListPlus,
  Globe,
  Layers,
  Monitor,
  Moon,
  Network,
  Palette,
  Puzzle,
  Send,
  Server,
  Shield,
  Sun,
  X,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/Toaster';
import { useProviderModels } from '@/hooks/useProviderModels';
import {
  formatModelMatrixRouteLabel,
  MODEL_MATRIX_DEFAULT_ROUTE,
  MODEL_MATRIX_KNOWN_ROUTES,
  MODEL_MATRIX_ROUTE_GROUPS,
} from '@/lib/model-matrix-routes';
import { useWebSocket } from '@/hooks/useWebSocket';
import { i18n, LANGUAGES, useAppTranslation } from '@/i18n';
import { showPanel } from '@/lib/view-navigation';
import { useConfigStore, useUIStore } from '@/stores';
import { useLocalPrefs, type LocalPrefs } from '@/stores/local-prefs';
import type { WSServerMessage } from '@/types';
import { FallbackEditor } from '../FallbackEditor';
import { useTheme } from '../ThemeProvider';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { MCPSection } from './MCPSection';
import { ModelSection } from './ModelSection';
import { PreferenceSelect, PreferenceSlider } from './PreferenceControls';
import { PreferenceToggle } from './PreferenceToggle';
import {
  type CatalogProvider,
  ProviderSection,
  type ProviderTab,
  type SavedProvider,
} from './ProviderSection';

interface CatalogModel {
  id: string;
  name: string;
  releaseDate?: string | undefined;
  contextWindow?: number | undefined;
  inputCost?: number | undefined;
  outputCost?: number | undefined;
  capabilities: string[];
}

type ModelRouteEntry = LocalPrefs['modelMatrix'][string];
type ModelRouteRuntime = NonNullable<ModelRouteEntry['modelRuntime']>;
type ModelRouteReasoning = NonNullable<ModelRouteRuntime['reasoning']>;
type RouteReasoningModeControl = '' | NonNullable<ModelRouteReasoning['mode']>;
type RouteReasoningEffortControl =
  | ''
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';
type RoutePreserveControl = '' | 'on' | 'off';

const ROUTE_REASONING_MODES: Array<{ value: RouteReasoningModeControl; label: string }> = [
  { value: '', label: 'mode: inherit' },
  { value: 'auto', label: 'mode: auto' },
  { value: 'on', label: 'mode: on' },
  { value: 'off', label: 'mode: off' },
];

const ROUTE_REASONING_EFFORTS: Array<{ value: RouteReasoningEffortControl; label: string }> = [
  { value: '', label: 'effort: inherit' },
  { value: 'none', label: 'effort: none' },
  { value: 'minimal', label: 'effort: minimal' },
  { value: 'low', label: 'effort: low' },
  { value: 'medium', label: 'effort: medium' },
  { value: 'high', label: 'effort: high' },
  { value: 'xhigh', label: 'effort: xhigh' },
  { value: 'max', label: 'effort: max' },
];

const ROUTE_PRESERVE_OPTIONS: Array<{ value: RoutePreserveControl; label: string }> = [
  { value: '', label: 'preserve: inherit' },
  { value: 'on', label: 'preserve: on' },
  { value: 'off', label: 'preserve: off' },
];

const MODEL_MATRIX_KNOWN_ROUTE_SET = new Set(MODEL_MATRIX_KNOWN_ROUTES);

function buildRouteRuntime(
  mode: RouteReasoningModeControl,
  effort: RouteReasoningEffortControl,
  preserve: RoutePreserveControl,
): ModelRouteRuntime | undefined {
  const reasoning: ModelRouteReasoning = {};
  if (mode) reasoning.mode = mode;
  if (effort) reasoning.effort = effort;
  if (preserve) reasoning.preserve = preserve === 'on';
  return Object.keys(reasoning).length > 0 ? { reasoning } : undefined;
}

function routeRuntimeParts(reasoning: ModelRouteReasoning | undefined): string[] {
  if (!reasoning) return [];
  return [
    reasoning.mode ? `mode:${reasoning.mode}` : '',
    reasoning.effort ? `effort:${reasoning.effort}` : '',
    reasoning.preserve !== undefined ? `preserve:${reasoning.preserve ? 'on' : 'off'}` : '',
  ].filter(Boolean);
}

export function SettingsPanel() {
  const { provider, model: activeModel, setProvider, setModel, setConfig, wsConnected, wsUrl } = useConfigStore();
  const { theme, setTheme } = useTheme();
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

  // Display-only locale switch: write to localStorage ONLY (never syncPref /
  // updatePrefs — uiLocale must never reach the WS server or config.json).
  // The i18n module's useLocalPrefs.subscribe then drives i18n.changeLanguage
  // + <html lang>, so a plain store write is all that's needed here.
  const setUiLocale = useCallback((code: string) => {
    localPrefs.set({ uiLocale: code });
    // Defensive: also swap directly in case the subscriber hasn't mounted.
    if (i18n.language !== code) void i18n.changeLanguage(code);
  }, [localPrefs]);

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
  const [newRouteKey, setNewRouteKey] = useState(MODEL_MATRIX_DEFAULT_ROUTE);
  const [newRouteTarget, setNewRouteTarget] = useState('');
  const [newRouteReasoningMode, setNewRouteReasoningMode] =
    useState<RouteReasoningModeControl>('');
  const [newRouteReasoningEffort, setNewRouteReasoningEffort] =
    useState<RouteReasoningEffortControl>('');
  const [newRoutePreserve, setNewRoutePreserve] = useState<RoutePreserveControl>('');
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

  // Model selection
  const handleModelSelect = useCallback(
    (modelId: string) => {
      setModel(modelId);
      const currentProvider = useConfigStore.getState().provider;
      ws.switchModel?.(currentProvider, modelId);
      toast.success(`Switching to ${currentProvider} / ${modelId}…`);
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
      toast.error(`Fallback profile "${name}" already exists`);
      return;
    }
    setFallbackProfiles({ ...localPrefs.fallbackProfiles, [name]: [] });
    setNewFallbackProfileName('');
  }, [localPrefs.fallbackProfiles, newFallbackProfileName, setFallbackProfiles]);

  const createDefaultFallbackProfile = useCallback(() => {
    const primary = provider && activeModel ? `${provider}/${activeModel}` : '';
    if (!primary) {
      toast.error('Select a provider and model first');
      return;
    }
    const chain = [primary, ...localPrefs.fallbackModels].filter(
      (ref, index, arr) => ref && arr.indexOf(ref) === index,
    );
    setFallbackProfiles({ ...localPrefs.fallbackProfiles, default: chain });
    toast.success('Default fallback profile created');
  }, [activeModel, localPrefs.fallbackModels, localPrefs.fallbackProfiles, provider, setFallbackProfiles]);

  useEffect(() => {
    if (Object.keys(localPrefs.fallbackProfiles).length > 0) return;
    const primary = provider && activeModel ? `${provider}/${activeModel}` : '';
    if (!primary) return;
    const chain = [primary, ...localPrefs.fallbackModels].filter(
      (ref, index, arr) => ref && arr.indexOf(ref) === index,
    );
    setFallbackProfiles({ default: chain });
  }, [activeModel, localPrefs.fallbackModels, localPrefs.fallbackProfiles, provider, setFallbackProfiles]);

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
        toast.error(`Fallback profile "${name}" is empty`);
        return;
      }
      const slash = first.indexOf('/');
      const targetProvider = slash > 0 ? first.slice(0, slash) : provider;
      const targetModel = slash > 0 ? first.slice(slash + 1) : first;
      setProvider(targetProvider);
      setModel(targetModel);
      ws.switchModel?.(targetProvider, targetModel);
      syncPref('fallbackModels', chain.slice(1));
      toast.success(`Leader set from ${name}`);
    },
    [localPrefs.fallbackProfiles, provider, setModel, setProvider, syncPref, ws],
  );

  const setModelMatrix = useCallback(
    (next: typeof localPrefs.modelMatrix) => syncPref('modelMatrix', next),
    [syncPref],
  );

  const addModelRoute = useCallback(() => {
    const key = newRouteKey.trim();
    const target = newRouteTarget.trim();
    const runtime = buildRouteRuntime(newRouteReasoningMode, newRouteReasoningEffort, newRoutePreserve);
    if (!key || (!target && !runtime)) return;
    const entry: ModelRouteEntry = target
      ? localPrefs.fallbackProfiles[target]
        ? { fallbackProfile: target }
        : target.includes('/')
          ? {
              provider: target.slice(0, target.indexOf('/')),
              model: target.slice(target.indexOf('/') + 1),
            }
          : { model: target }
      : {};
    const previousRuntime = localPrefs.modelMatrix[key]?.modelRuntime;
    if (runtime) entry.modelRuntime = runtime;
    else if (previousRuntime) entry.modelRuntime = previousRuntime;
    setModelMatrix({ ...localPrefs.modelMatrix, [key]: entry });
    setNewRouteTarget('');
    setNewRouteReasoningMode('');
    setNewRouteReasoningEffort('');
    setNewRoutePreserve('');
  }, [
    localPrefs.fallbackProfiles,
    localPrefs.modelMatrix,
    newRouteKey,
    newRoutePreserve,
    newRouteReasoningEffort,
    newRouteReasoningMode,
    newRouteTarget,
    setModelMatrix,
  ]);

  const removeModelRoute = useCallback(
    (key: string) => {
      const { [key]: _removed, ...rest } = localPrefs.modelMatrix;
      setModelMatrix(rest);
    },
    [localPrefs.modelMatrix, setModelMatrix],
  );

  const updateModelRouteReasoning = useCallback(
    (
      key: string,
      field: 'mode' | 'effort' | 'preserve',
      value: RouteReasoningModeControl | RouteReasoningEffortControl | RoutePreserveControl,
    ) => {
      const matrix = { ...localPrefs.modelMatrix };
      const entry = { ...(matrix[key] ?? {}) } as ModelRouteEntry;
      const modelRuntime = { ...(entry.modelRuntime ?? {}) } as ModelRouteRuntime;
      const reasoning = { ...(modelRuntime.reasoning ?? {}) } as ModelRouteReasoning;

      if (field === 'mode') {
        if (value) reasoning.mode = value as NonNullable<ModelRouteReasoning['mode']>;
        else delete reasoning.mode;
      } else if (field === 'effort') {
        if (value) reasoning.effort = value;
        else delete reasoning.effort;
      } else if (value) {
        reasoning.preserve = value === 'on';
      } else {
        delete reasoning.preserve;
      }

      if (Object.keys(reasoning).length > 0) modelRuntime.reasoning = reasoning;
      else delete modelRuntime.reasoning;

      if (Object.keys(modelRuntime).length > 0) entry.modelRuntime = modelRuntime;
      else delete entry.modelRuntime;

      if (entry.model || entry.fallbackProfile || entry.modelRuntime) matrix[key] = entry;
      else delete matrix[key];

      setModelMatrix(matrix);
    },
    [localPrefs.modelMatrix, setModelMatrix],
  );

  const formatRouteTarget = (entry: (typeof localPrefs.modelMatrix)[string]) => {
    const modelRef = entry.provider && entry.model ? `${entry.provider}/${entry.model}` : entry.model;
    const reasoning = entry.modelRuntime?.reasoning;
    return [
      modelRef ?? (!entry.fallbackProfile && reasoning ? 'leader model' : ''),
      entry.fallbackProfile ? `profile:${entry.fallbackProfile}` : '',
      ...routeRuntimeParts(reasoning),
    ]
      .filter(Boolean)
      .join(' + ');
  };

  const customModelRouteKeys = Array.from(
    new Set(
      [...Object.keys(localPrefs.modelMatrix), newRouteKey].filter(
        (key) => key && !MODEL_MATRIX_KNOWN_ROUTE_SET.has(key),
      ),
    ),
  ).sort((a, b) => a.localeCompare(b));

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b bg-card shrink-0">
        <h1 className="text-lg font-semibold">Settings</h1>
        <Button variant="ghost" size="icon" onClick={() => showPanel('chat')}>
          <X className="h-4 w-4" />
        </Button>
      </header>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-2xl p-6">
          <Tabs defaultValue="provider">
            <TabsList className="w-full justify-start mb-6 grid grid-cols-6">
              <TabsTrigger value="provider" className="gap-1 text-xs">
                <Network className="h-3.5 w-3.5" />
                Provider
              </TabsTrigger>
              <TabsTrigger value="connection" className="gap-1 text-xs">
                <Globe className="h-3.5 w-3.5" />
                Connect
              </TabsTrigger>
              <TabsTrigger value="appearance" className="gap-1 text-xs">
                <Palette className="h-3.5 w-3.5" />
                Look
              </TabsTrigger>
              <TabsTrigger value="agent" className="gap-1 text-xs">
                <Bot className="h-3.5 w-3.5" />
                Agent
              </TabsTrigger>
              <TabsTrigger value="features" className="gap-1 text-xs">
                <Puzzle className="h-3.5 w-3.5" />
                Feat.
              </TabsTrigger>
              <TabsTrigger value="mcp" className="gap-1 text-xs">
                <Server className="h-3.5 w-3.5" />
                MCP
              </TabsTrigger>
            </TabsList>

            {/* Provider & Model Tab — pick a provider, then its model */}
            <TabsContent value="provider" className="space-y-4">
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
                  Model
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

            {/* Connection Tab */}
            <TabsContent value="connection" className="space-y-4">
              <div className="space-y-3">
                <label
                  htmlFor="websocket-url"
                  className="text-sm font-medium flex items-center gap-2"
                >
                  <Globe className="h-4 w-4 text-muted-foreground" />
                  WebSocket Server URL
                </label>
                <Input
                  id="websocket-url"
                  value={wsUrl}
                  onChange={(e) => setConfig({ wsUrl: e.target.value })}
                  placeholder="ws://localhost:3457"
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  URL of the agent WebSocket server. The server runs alongside the CLI.
                </p>
              </div>

              <div className="p-4 rounded-lg border bg-muted/50">
                <h4 className="text-sm font-medium mb-2">Starting the WebSocket Server</h4>
                <p className="text-xs text-muted-foreground mb-3">
                  Standalone: run <code className="bg-muted px-1 py-0.5 rounded">./dev.ps1</code>{' '}
                  from the repo root, or set WS_HOST/WS_PORT before launching{' '}
                  <code className="bg-muted px-1 py-0.5 rounded">wstackui</code>
                  . Or alongside the CLI:{' '}
                  <code className="bg-muted px-1 py-0.5 rounded">wstack --webui</code>.
                </p>
              </div>
            </TabsContent>

            {/* Appearance Tab */}
            <TabsContent value="appearance" className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold mb-3">{t('settings:appearance.themeHeading')}</h3>
                <div className="grid grid-cols-3 gap-2 max-w-md">
                  <Button
                    variant={theme === 'light' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setTheme('light')}
                  >
                    <Sun className="h-4 w-4 mr-1" />
                    {t('settings:appearance.themeLight')}
                  </Button>
                  <Button
                    variant={theme === 'dark' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setTheme('dark')}
                  >
                    <Moon className="h-4 w-4 mr-1" />
                    {t('settings:appearance.themeDark')}
                  </Button>
                  <Button
                    variant={theme === 'system' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setTheme('system')}
                  >
                    <Monitor className="h-4 w-4 mr-1" />
                    {t('settings:appearance.themeSystem')}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-2">{t('settings:appearance.themeSystemHint')}</p>
              </div>

              <div className="pt-2 border-t">
                <h3 className="text-sm font-semibold mb-3 mt-3">{t('settings:appearance.languageHeading')}</h3>
                <PreferenceSelect
                  label={t('settings:appearance.languageLabel')}
                  hint={t('settings:appearance.languageHint')}
                  value={localPrefs.uiLocale}
                  options={LANGUAGES.map((l) => ({ value: l.code, label: l.name }))}
                  onChange={setUiLocale}
                />
              </div>

              <div className="pt-2 border-t">
                <h3 className="text-sm font-semibold mb-3 mt-3">{t('settings:appearance.preferencesHeading')}</h3>
                <PreferenceToggle
                  label={t('settings:appearance.compactDensity')}
                  hint={t('settings:appearance.compactDensityHint')}
                  selector={(s) => s.compactMode}
                  onChange={() => useUIStore.getState().toggleCompactMode()}
                />
                <PreferenceToggle
                  label={t('settings:appearance.soundOnComplete')}
                  hint={t('settings:appearance.soundOnCompleteHint')}
                  selector={null}
                  configKey="soundOnComplete"
                />
                <PreferenceToggle
                  label={t('settings:appearance.titleAnimation')}
                  hint={t('settings:appearance.titleAnimationHint')}
                  value={localPrefs.titleAnimation}
                  onChange={() => syncPref('titleAnimation', !localPrefs.titleAnimation)}
                />
              </div>
            </TabsContent>

            {/* Agent Tab */}
            <TabsContent value="agent" className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <Activity className="h-4 w-4 text-muted-foreground" />
                  Autonomy & Behavior
                </h3>
                <PreferenceSelect
                  label="Autonomy mode"
                  hint="How independently the agent proceeds between turns."
                  value={localPrefs.autonomy}
                  options={[
                    { value: 'off' as const, label: 'Off — full manual control' },
                    { value: 'suggest' as const, label: 'Suggest — suggests next steps' },
                    { value: 'auto' as const, label: 'Auto — brief confirmation delay' },
                    { value: 'eternal' as const, label: 'Eternal — autonomous until goal done' },
                    {
                      value: 'eternal-parallel' as const,
                      label: 'Eternal Parallel — multi-agent fleet',
                    },
                  ]}
                  onChange={(v) => {
                    localPrefs.set({ autonomy: v });
                    switchAutonomy(v);
                  }}
                />
                <PreferenceSlider
                  label="Auto-proceed delay"
                  hint="Milliseconds before the agent auto-proceeds in Auto mode. 0 = immediate."
                  value={localPrefs.autonomyDelayMs}
                  min={0}
                  max={10000}
                  step={500}
                  unit="ms"
                  onChange={(v) => syncPref('autonomyDelayMs', v)}
                />
                <PreferenceToggle
                  label="YOLO mode"
                  hint="Bypass tool confirmation prompts — the agent runs without asking."
                  value={localPrefs.yolo}
                  onChange={() => syncPref('yolo', !localPrefs.yolo)}
                />
              </div>

              <div className="pt-2 border-t">
                <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                  <Zap className="h-4 w-4 text-muted-foreground" />
                  Prompt Refinement
                </h3>
                <PreferenceToggle
                  label="Enable refine"
                  hint="Rewrite prompts before sending — clearer instructions, better results."
                  value={localPrefs.enhanceEnabled}
                  onChange={() => syncPref('enhanceEnabled', !localPrefs.enhanceEnabled)}
                />
                <PreferenceSlider
                  label="Refine delay"
                  hint="Countdown before the refined prompt auto-sends."
                  value={localPrefs.enhanceDelayMs}
                  min={30000}
                  max={120000}
                  step={15000}
                  unit="ms"
                  onChange={(v) => syncPref('enhanceDelayMs', v)}
                />
                <PreferenceSelect
                  label="Refine language"
                  hint="Keep your language or translate to English for the model."
                  value={localPrefs.enhanceLanguage}
                  options={[
                    { value: 'original' as const, label: 'Original — keep your language' },
                    { value: 'english' as const, label: 'English — translate to English' },
                  ]}
                  onChange={(v) => syncPref('enhanceLanguage', v)}
                />
              </div>

              <div className="pt-2 border-t">
                <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-muted-foreground" />
                  Reasoning & Cache
                </h3>
                <PreferenceSelect
                  label="Reasoning mode"
                  hint="Control how the model uses extended thinking. Auto = provider default."
                  value={localPrefs.reasoningMode}
                  options={[
                    { value: 'auto' as const, label: 'Auto — provider default' },
                    { value: 'on' as const, label: 'On — force thinking on' },
                    { value: 'off' as const, label: 'Off — force thinking off' },
                  ]}
                  onChange={(v) => syncPref('reasoningMode', v)}
                />
                <PreferenceSelect
                  label="Reasoning effort"
                  hint="How much compute the model spends thinking. Only sent when the model supports it."
                  value={localPrefs.reasoningEffort}
                  options={[
                    { value: 'none' as const, label: 'None' },
                    { value: 'minimal' as const, label: 'Minimal' },
                    { value: 'low' as const, label: 'Low' },
                    { value: 'medium' as const, label: 'Medium' },
                    { value: 'high' as const, label: 'High' },
                    { value: 'xhigh' as const, label: 'Extra High' },
                    { value: 'max' as const, label: 'Max' },
                  ]}
                  onChange={(v) => syncPref('reasoningEffort', v)}
                />
                <PreferenceToggle
                  label="Preserve thinking"
                  hint="Keep reasoning blocks across turns for context continuity."
                  value={localPrefs.reasoningPreserve}
                  onChange={() => syncPref('reasoningPreserve', !localPrefs.reasoningPreserve)}
                />
                <PreferenceSelect
                  label="Cache TTL"
                  hint="Prompt cache time-to-live. 1h costs more on write but saves on repeat reads (Anthropic)."
                  value={localPrefs.cacheTtl}
                  options={[
                    { value: 'default' as const, label: 'Default — provider default' },
                    { value: '5m' as const, label: '5 minutes' },
                    { value: '1h' as const, label: '1 hour' },
                  ]}
                  onChange={(v) => syncPref('cacheTtl', v)}
                />
                <p className="text-xs text-muted-foreground mt-2">
                  Use <code className="bg-muted px-1 py-0.5 rounded">wstack models caps</code> to
                  check what the current model supports. Unsupported settings are silently omitted
                  per-request.
                </p>
              </div>

              <div className="pt-2 border-t">
                <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-muted-foreground" />
                  Model Fallbacks
                </h3>
                <p className="mb-2 text-xs text-muted-foreground">
                  When the active model rate-limits (429/529), 5xx-errors, or stalls — after its own
                  retries — the agent rotates to the next model in this chain. Also used as the
                  default for SDD worker subagents.
                </p>
                <FallbackEditor
                  value={localPrefs.fallbackModels}
                  candidates={fallbackCandidates}
                  onChange={(next) => syncPref('fallbackModels', next)}
                />
                <div className="pt-1">
                  <PreferenceToggle
                    label="Auto fallback"
                    hint="When the chain above is empty, auto-derive one from your keyed providers."
                    value={localPrefs.fallbackAuto}
                    onChange={() => syncPref('fallbackAuto', !localPrefs.fallbackAuto)}
                  />
                  <PreferenceToggle
                    label="Favorites only"
                    hint="When auto fallback derives a chain, restrict it to your favorite models."
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
                  Fallback Profiles
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
                    Add
                  </Button>
                </div>
                <div className="mt-3 space-y-3">
                  {Object.keys(localPrefs.fallbackProfiles).length === 0 ? (
                    <div className="rounded-md border border-dashed border-border p-3">
                      <p className="text-xs text-muted-foreground">
                        No named fallback profiles yet.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-2"
                        onClick={createDefaultFallbackProfile}
                      >
                        Create default from active model
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
                                Use chain
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => setLeaderFromFallbackProfile(name)}
                              >
                                Set leader
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => removeFallbackProfile(name)}
                              >
                                Remove
                              </Button>
                            </div>
                          </div>
                          <FallbackEditor
                            value={chain}
                            candidates={fallbackCandidates}
                            placeholder="Add model to profile…"
                            emptyHint="Profile is empty."
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
                  Favorite Models
                </h3>
                <FallbackEditor
                  value={localPrefs.favoriteModels}
                  candidates={fallbackCandidates}
                  placeholder="Add favorite model…"
                  emptyHint="Favorites are shown first and can constrain auto fallback."
                  onChange={(next) => syncPref('favoriteModels', next)}
                />
              </div>

              <div className="pt-2 border-t">
                <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                  <Layers className="h-4 w-4 text-muted-foreground" />
                  Model Routing
                </h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,180px)_1fr_auto]">
                  <select
                    aria-label="Model route key"
                    value={newRouteKey}
                    onChange={(e) => setNewRouteKey(e.target.value)}
                    className="h-9 min-w-0 rounded-md border bg-background px-3 font-mono text-sm"
                  >
                    <option value={MODEL_MATRIX_DEFAULT_ROUTE}>
                      {formatModelMatrixRouteLabel(MODEL_MATRIX_DEFAULT_ROUTE)}
                    </option>
                    <optgroup label="Phases">
                      {MODEL_MATRIX_ROUTE_GROUPS.map((group) => (
                        <option key={group.phase} value={group.phase}>
                          {formatModelMatrixRouteLabel(group.phase)}
                        </option>
                      ))}
                    </optgroup>
                    {MODEL_MATRIX_ROUTE_GROUPS.map((group) => (
                      <optgroup key={group.phase} label={`${group.label} roles`}>
                        {group.roles.map((role) => (
                          <option key={role.role} value={role.role}>
                            {formatModelMatrixRouteLabel(role.role)}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                    {customModelRouteKeys.length > 0 ? (
                      <optgroup label="Custom existing routes">
                        {customModelRouteKeys.map((key) => (
                          <option key={key} value={key}>
                            {formatModelMatrixRouteLabel(key)}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                  </select>
                  <Input
                    value={newRouteTarget}
                    onChange={(e) => setNewRouteTarget(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addModelRoute();
                    }}
                    placeholder="fallback1, provider/model, or blank"
                    className="font-mono text-sm"
                  />
                  <Button type="button" variant="outline" onClick={addModelRoute}>
                    Set
                  </Button>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <select
                    aria-label="New route reasoning mode"
                    value={newRouteReasoningMode}
                    onChange={(e) => setNewRouteReasoningMode(e.target.value as RouteReasoningModeControl)}
                    className="h-8 min-w-0 rounded-md border bg-background px-2 text-xs"
                  >
                    {ROUTE_REASONING_MODES.map((opt) => (
                      <option key={opt.value || 'inherit'} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="New route reasoning effort"
                    value={newRouteReasoningEffort}
                    onChange={(e) => setNewRouteReasoningEffort(e.target.value as RouteReasoningEffortControl)}
                    className="h-8 min-w-0 rounded-md border bg-background px-2 text-xs"
                  >
                    {ROUTE_REASONING_EFFORTS.map((opt) => (
                      <option key={opt.value || 'inherit'} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="New route reasoning preserve"
                    value={newRoutePreserve}
                    onChange={(e) => setNewRoutePreserve(e.target.value as RoutePreserveControl)}
                    className="h-8 min-w-0 rounded-md border bg-background px-2 text-xs"
                  >
                    {ROUTE_PRESERVE_OPTIONS.map((opt) => (
                      <option key={opt.value || 'inherit'} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="mt-3 space-y-1.5">
                  {Object.keys(localPrefs.modelMatrix).length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No model routes yet.
                    </p>
                  ) : (
                    Object.entries(localPrefs.modelMatrix)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([key, entry]) => (
                        <div
                          key={key}
                          className="rounded-md border border-border bg-muted px-2 py-1.5 text-xs"
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className="w-40 shrink-0 truncate font-mono text-muted-foreground"
                              title={key}
                            >
                              {formatModelMatrixRouteLabel(key)}
                            </span>
                            <span className="min-w-0 flex-1 truncate font-mono">
                              {formatRouteTarget(entry)}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => removeModelRoute(key)}
                            >
                              Remove
                            </Button>
                          </div>
                          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                            <select
                              aria-label={`Reasoning mode for ${key}`}
                              value={entry.modelRuntime?.reasoning?.mode ?? ''}
                              onChange={(e) =>
                                updateModelRouteReasoning(key, 'mode', e.target.value as RouteReasoningModeControl)
                              }
                              className="h-8 min-w-0 rounded-md border bg-background px-2 text-xs"
                            >
                              {ROUTE_REASONING_MODES.map((opt) => (
                                <option key={opt.value || 'inherit'} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                            <select
                              aria-label={`Reasoning effort for ${key}`}
                              value={entry.modelRuntime?.reasoning?.effort ?? ''}
                              onChange={(e) =>
                                updateModelRouteReasoning(key, 'effort', e.target.value as RouteReasoningEffortControl)
                              }
                              className="h-8 min-w-0 rounded-md border bg-background px-2 text-xs"
                            >
                              {ROUTE_REASONING_EFFORTS.map((opt) => (
                                <option key={opt.value || 'inherit'} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                            <select
                              aria-label={`Reasoning preserve for ${key}`}
                              value={
                                entry.modelRuntime?.reasoning?.preserve === undefined
                                  ? ''
                                  : entry.modelRuntime.reasoning.preserve
                                    ? 'on'
                                    : 'off'
                              }
                              onChange={(e) =>
                                updateModelRouteReasoning(key, 'preserve', e.target.value as RoutePreserveControl)
                              }
                              className="h-8 min-w-0 rounded-md border bg-background px-2 text-xs"
                            >
                              {ROUTE_PRESERVE_OPTIONS.map((opt) => (
                                <option key={opt.value || 'inherit'} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                      ))
                  )}
                </div>
              </div>

              <div className="pt-2 border-t">
                <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                  <Network className="h-4 w-4 text-muted-foreground" />
                  HQ Client
                </h3>
                <PreferenceToggle
                  label="HQ publishing"
                  hint="Publish this WebUI/client session to WrongStack HQ. Same-machine clients can auto-discover local HQ auth; remote clients use the URL/token below."
                  value={localPrefs.hqEnabled}
                  onChange={() => syncPref('hqEnabled', !localPrefs.hqEnabled)}
                />
                <div className="space-y-1 py-2">
                  <label className="text-sm font-medium">HQ URL</label>
                  <Input
                    value={localPrefs.hqUrl}
                    placeholder="http://host:3499"
                    onChange={(e) => syncPref('hqUrl', e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave empty for same-machine auto-discovery.
                  </p>
                </div>
                <div className="space-y-1 py-2">
                  <label className="text-sm font-medium">HQ client token</label>
                  <Input
                    type="password"
                    value={localPrefs.hqToken}
                    placeholder="Client token from wstack --hq"
                    onChange={(e) => syncPref('hqToken', e.target.value)}
                  />
                </div>
                <PreferenceToggle
                  label="Raw HQ content"
                  hint="Send raw content previews to HQ instead of redacted previews."
                  value={localPrefs.hqRawContent}
                  onChange={() => syncPref('hqRawContent', !localPrefs.hqRawContent)}
                />
              </div>

              <div className="pt-2 border-t">
                <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                  <Zap className="h-4 w-4 text-muted-foreground" />
                  Execution
                </h3>
                <PreferenceSlider
                  label="Max iterations per run"
                  hint="Hard cap on LLM turns per agent.run()."
                  value={localPrefs.maxIterations}
                  min={10}
                  max={2000}
                  step={10}
                  onChange={(v) => syncPref('maxIterations', v)}
                />
                <PreferenceSlider
                  label="Auto-proceed max iterations"
                  hint="Stop auto-proceed after N iterations. 0 = unlimited."
                  value={localPrefs.autoProceedMaxIterations}
                  min={0}
                  max={250}
                  step={5}
                  onChange={(v) => syncPref('autoProceedMaxIterations', v)}
                />
                <PreferenceToggle
                  label="Confirm before exit"
                  hint="First Ctrl+C aborts work, second confirms exit."
                  value={localPrefs.confirmExit}
                  onChange={() => syncPref('confirmExit', !localPrefs.confirmExit)}
                />
                <PreferenceToggle
                  label="Chime on completion"
                  hint="Terminal bell when an agent run finishes."
                  value={localPrefs.chime}
                  onChange={() => syncPref('chime', !localPrefs.chime)}
                />
              </div>

              <div className="pt-2 border-t">
                <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                  <Layers className="h-4 w-4 text-muted-foreground" />
                  Fleet & Streaming
                </h3>
                <PreferenceToggle
                  label="Stream fleet events"
                  hint="Show live subagent activity in the fleet panel."
                  value={localPrefs.streamFleet}
                  onChange={() => syncPref('streamFleet', !localPrefs.streamFleet)}
                />
                <PreferenceSlider
                  label="Max concurrent subagents"
                  hint="Maximum number of subagents that can run simultaneously."
                  value={localPrefs.maxConcurrent}
                  min={1}
                  max={50}
                  step={1}
                  onChange={(v) => syncPref('maxConcurrent', v)}
                />
                <PreferenceToggle
                  label="Next-step prediction"
                  hint="After a turn completes, predict likely next steps."
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
                  Telegram Notifications
                </h3>
                {localPrefs.tgConfigured ? (
                  <>
                    <PreferenceToggle
                      label="Session end"
                      hint="Send a summary when a session ends."
                      value={localPrefs.tgSessionEnd}
                      onChange={() => syncPref('tgSessionEnd', !localPrefs.tgSessionEnd)}
                    />
                    <PreferenceToggle
                      label="Delegate finished"
                      hint="Send a humanized note when a subagent completes."
                      value={localPrefs.tgDelegate}
                      onChange={() => syncPref('tgDelegate', !localPrefs.tgDelegate)}
                    />
                    <PreferenceToggle
                      label="Long-running tools"
                      hint={`Notify when a tool exceeds ${localPrefs.tgLongToolMs}ms. Set 0 to disable.`}
                      value={localPrefs.tgLongToolMs > 0}
                      onChange={() =>
                        syncPref('tgLongToolMs', localPrefs.tgLongToolMs > 0 ? 0 : 30_000)
                      }
                    />
                    <p className="text-xs text-muted-foreground mt-2">Changes apply immediately.</p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Telegram is not configured. Run{' '}
                    <code className="bg-muted px-1 py-0.5 rounded">/telegram-setup</code> in the CLI
                    to connect a bot first.
                  </p>
                )}
              </div>
            </TabsContent>

            {/* Features Tab */}
            <TabsContent value="features" className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <Puzzle className="h-4 w-4 text-muted-foreground" />
                  Feature Flags
                </h3>
                <PreferenceToggle
                  label="MCP servers"
                  hint="Enable Model Context Protocol integrations."
                  value={localPrefs.featureMcp}
                  onChange={() => syncPref('featureMcp', !localPrefs.featureMcp)}
                />
                <PreferenceToggle
                  label="Plugins"
                  hint="Load and run user-installed plugins."
                  value={localPrefs.featurePlugins}
                  onChange={() => syncPref('featurePlugins', !localPrefs.featurePlugins)}
                />
                <PreferenceToggle
                  label="Memory"
                  hint="Persist and recall facts across sessions."
                  value={localPrefs.featureMemory}
                  onChange={() => syncPref('featureMemory', !localPrefs.featureMemory)}
                />
                <PreferenceToggle
                  label="Skills"
                  hint="Load domain-specific skill prompts."
                  value={localPrefs.featureSkills}
                  onChange={() => syncPref('featureSkills', !localPrefs.featureSkills)}
                />
                <PreferenceToggle
                  label="Models registry"
                  hint="Use the models.dev catalog for provider discovery."
                  value={localPrefs.featureModelsRegistry}
                  onChange={() =>
                    syncPref('featureModelsRegistry', !localPrefs.featureModelsRegistry)
                  }
                />
                <PreferenceToggle
                  label="Index on start"
                  hint="Build the codebase symbol index at session start."
                  value={localPrefs.indexOnStart}
                  onChange={() => syncPref('indexOnStart', !localPrefs.indexOnStart)}
                />
              </div>

              <div className="pt-2 border-t">
                <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
                  <Shield className="h-4 w-4 text-muted-foreground" />
                  Context & Debug
                </h3>
                <PreferenceToggle
                  label="Auto-compact context"
                  hint="Automatically trim the context window when near limits."
                  value={localPrefs.contextAutoCompact}
                  onChange={() => syncPref('contextAutoCompact', !localPrefs.contextAutoCompact)}
                />
                <PreferenceSelect
                  label="Compactor strategy"
                  hint="How the context is compacted when it grows too large."
                  value={localPrefs.contextStrategy}
                  options={[
                    { value: 'hybrid' as const, label: 'Hybrid — fast rules (default)' },
                    { value: 'intelligent' as const, label: 'Intelligent — LLM summarization' },
                    { value: 'selective' as const, label: 'Selective — LLM-driven selection' },
                  ]}
                  onChange={(v) => syncPref('contextStrategy', v)}
                />
                <PreferenceSelect
                  label="Context mode"
                  hint="Context window policy — balanced is the default."
                  value={localPrefs.contextMode}
                  options={[
                    { value: 'balanced' as const, label: 'Balanced — normal context usage' },
                    { value: 'frugal' as const, label: 'Frugal — conservative token use' },
                    { value: 'deep' as const, label: 'Deep — larger context for complex tasks' },
                    { value: 'archival' as const, label: 'Archival — maximize context retention' },
                  ]}
                  onChange={(v) => syncPref('contextMode', v)}
                />
                <PreferenceSelect
                  label="Token-saving mode"
                  hint="How aggressively to reduce token usage."
                  value={localPrefs.tokenSavingTier}
                  options={[
                    { value: 'off' as const, label: 'Off — no token saving' },
                    { value: 'minimal' as const, label: 'Minimal — basic optimization' },
                    { value: 'light' as const, label: 'Light — moderate reduction' },
                    { value: 'medium' as const, label: 'Medium — significant savings' },
                    { value: 'aggressive' as const, label: 'Aggressive — maximum compression' },
                  ]}
                  onChange={(v) => syncPref('tokenSavingTier', v)}
                />
                <PreferenceSelect
                  label="Log level"
                  hint="Minimum severity for server-side logging."
                  value={localPrefs.logLevel}
                  options={[
                    { value: 'debug' as const, label: 'Debug — everything' },
                    { value: 'info' as const, label: 'Info — normal flow' },
                    { value: 'warn' as const, label: 'Warn — problems only' },
                    { value: 'error' as const, label: 'Error — failures only' },
                  ]}
                  onChange={(v) => syncPref('logLevel', v)}
                />
                <PreferenceSelect
                  label="Audit level"
                  hint="Detail level for session audit logs."
                  value={localPrefs.auditLevel}
                  options={[
                    { value: 'minimal' as const, label: 'Minimal — errors only' },
                    { value: 'standard' as const, label: 'Standard — tool calls + errors' },
                    { value: 'full' as const, label: 'Full — every event (large logs)' },
                  ]}
                  onChange={(v) => syncPref('auditLevel', v)}
                />
              </div>
            </TabsContent>

            {/* MCP Servers Tab */}
            <TabsContent value="mcp" className="space-y-4">
              {!localPrefs.featureMcp ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Server className="w-10 h-10 mx-auto mb-2 opacity-50" />
                  <p>MCP servers are disabled.</p>
                  <p className="text-sm mt-1">
                    Enable the "MCP servers" feature flag in the Features tab to use this section.
                  </p>
                </div>
              ) : (
                <MCPSection />
              )}
            </TabsContent>
          </Tabs>
        </div>
      </ScrollArea>
    </div>
  );
}
