import { useWebSocket } from '@/hooks/useWebSocket';
import { useConfigStore, useUIStore } from '@/stores';
import type { WSServerMessage } from '@/types';
import { toast } from '@/components/Toaster';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import {
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  Cpu,
  KeyRound,
  Loader2,
  Network,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';

// ── Types ──────────────────────────────────────────────────────────────────────

interface CatalogProvider {
  id: string;
  name: string;
  family: string;
  apiBase?: string | undefined;
  envVars: string[];
  modelCount: number;
  hasApiKey: boolean;
}

interface CatalogModel {
  id: string;
  name: string;
  releaseDate?: string | undefined;
  contextWindow?: number | undefined;
  inputCost?: number | undefined;
  outputCost?: number | undefined;
  capabilities: string[];
}

interface SavedProvider {
  id: string;
  family?: string | undefined;
  baseUrl?: string | undefined;
  apiKeys: Array<{
    label: string;
    maskedKey: string;
    isActive: boolean;
    createdAt: string;
  }>;
}

// ── Provider Card ─────────────────────────────────────────────────────────────

function ProviderCard({
  provider,
  isSelected,
  onSelect,
}: {
  provider: CatalogProvider;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full text-left rounded-xl border p-4 transition-all',
        'hover:border-primary/40 hover:bg-primary/5',
        isSelected
          ? 'border-primary bg-primary/10 ring-1 ring-primary/30'
          : 'border-border bg-card',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">{provider.name}</span>
            {provider.hasApiKey && (
              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                <Check className="h-2.5 w-2.5" />
                Key set
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {provider.family} · {provider.modelCount} models
          </p>
        </div>
        {isSelected && (
          <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center shrink-0">
            <Check className="h-3 h-3 text-primary-foreground" />
          </div>
        )}
      </div>
    </button>
  );
}

// ── Model Card ────────────────────────────────────────────────────────────────

function ModelCard({
  model,
  isSelected,
  onSelect,
}: {
  model: CatalogModel;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const inputCost = model.inputCost != null ? `$${model.inputCost}/1M tok` : null;
  const outputCost = model.outputCost != null ? `$${model.outputCost}/1M tok` : null;
  const contextWindow = model.contextWindow
    ? `${(model.contextWindow / 1_000_000).toFixed(0)}M ctx`
    : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full text-left rounded-xl border p-3 transition-all',
        'hover:border-primary/40 hover:bg-primary/5',
        isSelected
          ? 'border-primary bg-primary/10 ring-1 ring-primary/30'
          : 'border-border bg-card',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <span className="font-medium text-sm">{model.name}</span>
          <div className="flex flex-wrap items-center gap-1.5 mt-1">
            {contextWindow && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {contextWindow}
              </span>
            )}
            {inputCost && outputCost && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {inputCost} · {outputCost}
              </span>
            )}
            {model.capabilities.slice(0, 3).map((cap) => (
              <span
                key={cap}
                className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20"
              >
                {cap}
              </span>
            ))}
          </div>
        </div>
        {isSelected && (
          <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center shrink-0">
            <Check className="h-3 w-3 text-primary-foreground" />
          </div>
        )}
      </div>
    </button>
  );
}

// ── API Key Input ─────────────────────────────────────────────────────────────

function ApiKeyInput({
  providerId,
  onSave,
}: {
  providerId: string;
  onSave: (key: string) => void;
}) {
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('default');
  const [isLoading, setIsLoading] = useState(false);

  const handleSave = async () => {
    if (!key.trim()) return;
    setIsLoading(true);
    try {
      const ws = getWSClient(useConfigStore.getState().wsUrl);
      ws.addKey(providerId, label.trim() || 'default', key.trim());
      onSave(key.trim());
      setKey('');
      toast.success('API key saved');
    } catch (err) {
      toast.error('Failed to save API key');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-3 p-4 rounded-xl border border-amber-500/30 bg-amber-500/5">
      <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
        <KeyRound className="h-4 w-4" />
        <span className="text-sm font-medium">API Key required</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Enter your API key for {providerId}. The key is stored locally and never sent to
        any server other than the provider&apos;s API endpoint.
      </p>
      <div className="flex gap-2">
        <Input
          type="password"
          placeholder="sk-..."
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="font-mono text-sm"
        />
        <Input
          placeholder="Label (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-28 text-sm"
        />
      </div>
      <Button onClick={handleSave} disabled={!key.trim() || isLoading} size="sm">
        {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save Key'}
      </Button>
    </div>
  );
}

// ── Setup Screen ──────────────────────────────────────────────────────────────

export function SetupScreen() {
  const { setCurrentView } = useUIStore();
  const { provider, model, setProvider, setModel, wsConnected, wsUrl } = useConfigStore();
  const ws = useWebSocket();

  // Step: 'provider' | 'model' | 'apikey' | 'done'
  const [step, setStep] = useState<'provider' | 'model' | 'apikey' | 'done'>('provider');

  // Catalog data
  const [catalogProviders, setCatalogProviders] = useState<CatalogProvider[]>([]);
  const [catalogModels, setCatalogModels] = useState<Record<string, CatalogModel[]>>({});
  const [savedProviders, setSavedProviders] = useState<SavedProvider[]>([]);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  // Non-null when the provider catalog never arrived (unresponsive/crashed
  // backend or dropped connection). Drives an inline error card with retry
  // instead of an infinite spinner.
  const [catalogError, setCatalogError] = useState<string | null>(null);
  // Bumped by the retry button to re-run the catalog-fetch effect.
  const [reloadNonce, setReloadNonce] = useState(0);

  // Selected values
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  // Fetch provider catalog and saved providers on mount
  useEffect(() => {
    if (!wsConnected) return;

    const wsClient = getWSClient(wsUrl);

    // If the catalog never arrives within 8s the backend is likely down or
    // wedged — surface a retry card rather than spin forever.
    let catalogTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      catalogTimeout = null;
      setIsLoadingCatalog(false);
      setCatalogError(
        'The backend is not responding. It may have crashed or the connection dropped.',
      );
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

        // Auto-select if only one provider or if user already has one configured
        if (provider && sorted.some((p) => p.id === provider)) {
          setSelectedProvider(provider);
        } else if (sorted.length === 1) {
          setSelectedProvider(sorted[0].id);
        }
      }
    });

    const off2 = wsClient.on('provider.models', (msg: WSServerMessage) => {
      if (msg.type === 'provider.models') {
        const payload = msg.payload as { provider: string; models: CatalogModel[] };
        setCatalogModels((prev) => ({ ...prev, [payload.provider]: payload.models }));
        setIsLoadingModels(false);

        // Auto-select if only one model or if user already has one configured
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
        setSavedProviders(payload.providers.sort((a, b) => a.id.localeCompare(b.id)));
      }
    });

    setCatalogError(null);
    setIsLoadingCatalog(true);
    wsClient.listProviders();

    return () => {
      clearCatalogTimeout();
      off1?.();
      off2?.();
      off3?.();
    };
  }, [wsConnected, wsUrl, provider, model, reloadNonce]);

  // Retry catalog fetch after a timeout / lost connection.
  const handleRetryCatalog = useCallback(() => {
    setCatalogError(null);
    setReloadNonce((n) => n + 1);
  }, []);

  // Fetch models when provider is selected
  useEffect(() => {
    if (!selectedProvider || !wsConnected) return;
    const wsClient = getWSClient(wsUrl);

    if (!catalogModels[selectedProvider]) {
      setIsLoadingModels(true);
      wsClient.listProviderModels(selectedProvider);
    }
  }, [selectedProvider, wsConnected, wsUrl, catalogModels]);

  // Check if selected provider needs an API key
  const selectedProviderData = catalogProviders.find((p) => p.id === selectedProvider);
  const savedProviderData = savedProviders.find((p) => p.id === selectedProvider);
  const hasActiveKey =
    savedProviderData?.apiKeys.some((k) => k.isActive) || selectedProviderData?.hasApiKey;

  const handleProviderSelect = useCallback((providerId: string) => {
    setSelectedProvider(providerId);
    setSelectedModel(null); // Reset model selection
    setStep('model');
  }, []);

  const handleModelSelect = useCallback(
    (modelId: string) => {
      setSelectedModel(modelId);
      if (!hasActiveKey) {
        setStep('apikey');
      } else {
        setStep('done');
      }
    },
    [hasActiveKey],
  );

  const handleApiKeySaved = useCallback(() => {
    setStep('done');
  }, []);

  const handleStartSession = useCallback(() => {
    if (!selectedProvider || !selectedModel) return;

    // Save to config store
    setProvider(selectedProvider);
    setModel(selectedModel);

    // Switch model on the server and wait for the result before proceeding.
    // If switchModel fails (e.g. provider not in catalog), we surface the error
    // to the user instead of silently falling through to the chat view.
    const wsClient = getWSClient(wsUrl);
    wsClient.switchModel(selectedProvider, selectedModel);

    // One-time listener for the server's key.operation_result response.
    // Timeout after 5 s so a non-responsive server doesn't leave the UI stuck.
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => { if (timeoutId) clearTimeout(timeoutId); };

    const off = wsClient.on('key.operation_result', (msg: WSServerMessage) => {
      const p = (msg as { payload: { success: boolean; message: string } }).payload;
      cleanup();
      off();
      if (p.success) {
        // Switch succeeded — now start the session and go to chat.
        wsClient.newSession();
        setCurrentView('chat');
      } else {
        // Switch failed — show the error inline so the user stays on the
        // setup screen and can choose a different provider/model.
        toast.error(p.message);
      }
    });

    timeoutId = setTimeout(() => {
      cleanup();
      off();
      toast.error('Model switch timed out. Please try again.');
    }, 5000);
  }, [selectedProvider, selectedModel, setProvider, setModel, wsUrl, setCurrentView]);

  const currentModels = selectedProvider ? catalogModels[selectedProvider] ?? [] : [];
  const isLoading = isLoadingCatalog || isLoadingModels;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b bg-card shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary via-primary to-primary/60 flex items-center justify-center">
            <Zap className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Welcome to WrongStack</h1>
            <p className="text-xs text-muted-foreground">Configure your AI provider to get started</p>
          </div>
        </div>
      </header>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-6 max-w-2xl mx-auto space-y-8">
          {/* Progress steps */}
          <div className="flex items-center gap-2 text-sm">
            <div
              className={cn(
                'flex items-center gap-1.5',
                step === 'provider' && 'text-primary font-medium',
              )}
            >
              <Network className="h-4 w-4" />
              <span>Provider</span>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
            <div
              className={cn(
                'flex items-center gap-1.5',
                step === 'model' && 'text-primary font-medium',
              )}
            >
              <Cpu className="h-4 w-4" />
              <span>Model</span>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
            <div
              className={cn(
                'flex items-center gap-1.5',
                (step === 'apikey' || step === 'done') && 'text-primary font-medium',
              )}
            >
              <KeyRound className="h-4 w-4" />
              <span>API Key</span>
            </div>
          </div>

          {/* Provider Selection */}
          {step === 'provider' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-semibold flex items-center gap-2">
                  <Network className="h-4 w-4 text-primary" />
                  Choose a Provider
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Select the AI provider you want to use. You can add API keys in the next step.
                </p>
              </div>

              {catalogError ? (
                <div className="flex flex-col items-center text-center gap-4 py-12 rounded-xl border border-destructive/30 bg-destructive/5 px-6">
                  <div className="w-12 h-12 rounded-xl bg-destructive/10 border border-destructive/30 flex items-center justify-center">
                    <Network className="h-6 w-6 text-destructive" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-destructive">Can&apos;t reach the backend</p>
                    <p className="text-xs text-muted-foreground mt-1 max-w-sm">{catalogError}</p>
                  </div>
                  <Button onClick={handleRetryCatalog} size="sm" variant="outline">
                    <Loader2 className="h-4 w-4 mr-2" />
                    Retry
                  </Button>
                </div>
              ) : isLoadingCatalog ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {catalogProviders.map((p) => (
                    <ProviderCard
                      key={p.id}
                      provider={p}
                      isSelected={selectedProvider === p.id}
                      onSelect={() => handleProviderSelect(p.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Model Selection */}
          {step === 'model' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-semibold flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-primary" />
                  Choose a Model
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {selectedProviderData
                    ? `Models available for ${selectedProviderData.name}`
                    : 'Loading models...'}
                </p>
              </div>

              <button
                type="button"
                onClick={() => setStep('provider')}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                ← Change provider
              </button>

              {isLoadingModels ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : currentModels.length > 0 ? (
                <div className="grid grid-cols-1 gap-2">
                  {currentModels.map((m) => (
                    <ModelCard
                      key={m.id}
                      model={m}
                      isSelected={selectedModel === m.id}
                      onSelect={() => handleModelSelect(m.id)}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No models available. Please check your API key.
                </p>
              )}
            </div>
          )}

          {/* API Key Input */}
          {step === 'apikey' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-semibold flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-primary" />
                  Add Your API Key
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {selectedProviderData
                    ? `Enter your API key for ${selectedProviderData.name}. `
                    : 'Enter your API key. '}
                  The key is stored locally and encrypted.
                </p>
              </div>

              <button
                type="button"
                onClick={() => setStep('model')}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                ← Change model
              </button>

              {selectedProvider && <ApiKeyInput providerId={selectedProvider} onSave={handleApiKeySaved} />}
            </div>
          )}

          {/* Done / Ready */}
          {step === 'done' && (
            <div className="space-y-6">
              <div className="flex flex-col items-center text-center py-8">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500/20 to-emerald-500/5 border border-emerald-500/30 flex items-center justify-center mb-4">
                  <Check className="h-8 w-8 text-emerald-500" />
                </div>
                <h2 className="text-xl font-semibold">You&apos;re all set!</h2>
                <p className="text-sm text-muted-foreground mt-2 max-w-sm">
                  Configuration complete. Your agent is ready to start working.
                </p>
              </div>

              <div className="rounded-xl border bg-card p-4 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Provider</span>
                  <span className="font-medium">{selectedProvider}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Model</span>
                  <span className="font-medium">{selectedModel}</span>
                </div>
              </div>

              <Button onClick={handleStartSession} className="w-full" size="lg">
                <Bot className="h-4 w-4 mr-2" />
                Start Session
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
