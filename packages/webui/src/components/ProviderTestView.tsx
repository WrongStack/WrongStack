import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  FlaskConical,
  KeyRound,
  Loader2,
  Play,
  RotateCcw,
  Search,
  Settings,
  Star,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { isModelDisabled, isModelInFavorites } from '@/components/QuickModelSwitcher.filter';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { openMainView, showPanel } from '@/lib/view-navigation';
import { useConfigStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import type { WSServerMessage } from '@/types';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';

interface SavedProvider {
  id: string;
  type?: string | undefined;
  family?: string | undefined;
  apiKeys: Array<{ label: string; maskedKey: string; isActive: boolean }>;
}

interface CatalogModel {
  id: string;
  name: string;
  description?: string | undefined;
  contextWindow?: number | undefined;
  maxOutput?: number | undefined;
  inputCost?: number | undefined;
  outputCost?: number | undefined;
  capabilities: string[];
}

type TestResult = Extract<WSServerMessage, { type: 'provider.test.result' }>['payload'];
type Step = 'provider' | 'models' | 'results';

function compactNumber(value: number | undefined): string {
  if (!value) return '—';
  return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

function diagnosisLabel(value: string): string {
  const labels: Record<string, string> = {
    authentication: 'Authentication failed',
    quota_exhausted: 'Plan / credits exhausted',
    rate_limited: 'Rate limited',
    model_unavailable: 'Model unavailable',
    context_limit: 'Context limit exceeded',
    token_limit: 'Output-token limit rejected',
    timeout: 'Timed out',
    network: 'Network error',
    overloaded: 'Provider overloaded',
    server_error: 'Provider server error',
    invalid_request: 'Invalid request',
    cancelled: 'Cancelled',
    unknown: 'Unknown failure',
  };
  return labels[value] ?? value;
}

function matchesModelRef(
  raw: string,
  provider: string,
  model: string,
  defaultProvider: string,
): boolean {
  const clean = raw.trim().toLowerCase();
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();
  return (
    clean === `${normalizedProvider}/${normalizedModel}` ||
    clean === `${normalizedProvider} ${normalizedModel}` ||
    (normalizedProvider === defaultProvider.trim().toLowerCase() && clean === normalizedModel)
  );
}

export function ProviderTestView(): React.ReactElement {
  const ws = useWebSocket();
  const client = ws.client;
  const activeProvider = useConfigStore((state) => state.provider);
  const localPrefs = useLocalPrefs();
  const [step, setStep] = useState<Step>('provider');
  const [providers, setProviders] = useState<SavedProvider[]>([]);
  const [providerId, setProviderId] = useState('');
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [running, setRunning] = useState(false);
  const [requestId, setRequestId] = useState('');
  const [retryRequestId, setRetryRequestId] = useState('');
  const [retryingModel, setRetryingModel] = useState('');
  const [results, setResults] = useState<TestResult[]>([]);
  const [runError, setRunError] = useState('');
  const [disableTargets, setDisableTargets] = useState<TestResult[]>([]);

  useEffect(() => {
    if (!client) return;
    const offSaved = client.on('providers.saved', (message) => {
      if (message.type !== 'providers.saved') return;
      setProviders(message.payload.providers as SavedProvider[]);
    });
    const offModels = client.on('provider.models', (message) => {
      if (message.type !== 'provider.models' || message.payload.provider !== providerId) return;
      const next = message.payload.models as CatalogModel[];
      setModels(next);
      setSelected(
        new Set(
          next
            .filter((model) => !isModelDisabled(providerId, model.id, localPrefs.disabledModels))
            .map((model) => model.id),
        ),
      );
      setLoadingModels(false);
    });
    const offStarted = client.on('provider.test.started', (message) => {
      if (message.type !== 'provider.test.started') return;
      if (message.payload.requestId === requestId) setRunning(true);
    });
    const offResult = client.on('provider.test.result', (message) => {
      if (
        message.type !== 'provider.test.result' ||
        (message.payload.requestId !== requestId && message.payload.requestId !== retryRequestId)
      )
        return;
      setResults((current) => {
        const existing = current.findIndex((result) => result.modelId === message.payload.modelId);
        if (existing < 0) return [...current, message.payload];
        return current.map((result, index) => (index === existing ? message.payload : result));
      });
    });
    const offComplete = client.on('provider.test.complete', (message) => {
      if (message.type !== 'provider.test.complete') return;
      if (message.payload.requestId === requestId) {
        setRunning(false);
        setRunError(message.payload.error ?? '');
      }
      if (message.payload.requestId === retryRequestId) {
        setRetryRequestId('');
        setRetryingModel('');
      }
    });
    client.send({ type: 'providers.saved' });
    return () => {
      offSaved();
      offModels();
      offStarted();
      offResult();
      offComplete();
    };
  }, [client, localPrefs.disabledModels, providerId, requestId, retryRequestId]);

  const visibleModels = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return models;
    return models.filter(
      (model) =>
        model.id.toLowerCase().includes(normalized) ||
        model.name.toLowerCase().includes(normalized) ||
        model.description?.toLowerCase().includes(normalized),
    );
  }, [models, query]);

  const tested = results.length;
  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const disableCandidates = results.filter(
    (result) =>
      result.status === 'failed' &&
      !isModelDisabled(providerId, result.modelId, localPrefs.disabledModels),
  );

  const openModels = () => {
    if (!providerId) return;
    setLoadingModels(true);
    setModels([]);
    setSelected(new Set());
    setStep('models');
    client?.send({
      type: 'provider.models',
      payload: { providerId, includeDisabled: true },
    });
  };

  const runTests = () => {
    if (!client || selected.size === 0) return;
    const nextRequestId = crypto.randomUUID();
    setRequestId(nextRequestId);
    setResults([]);
    setRunError('');
    setRunning(true);
    setStep('results');
    client.send({
      type: 'provider.test.run',
      payload: {
        requestId: nextRequestId,
        providerId,
        modelIds: [...selected],
        timeoutMs: 45_000,
        maxTokens: 32,
      },
    });
  };

  const cancel = () => {
    if (!requestId) return;
    client?.send({ type: 'provider.test.cancel', payload: { requestId } });
  };

  const retryModel = (modelId: string) => {
    if (!client || running || retryingModel) return;
    const nextRequestId = crypto.randomUUID();
    setRetryRequestId(nextRequestId);
    setRetryingModel(modelId);
    client.send({
      type: 'provider.test.run',
      payload: {
        requestId: nextRequestId,
        providerId,
        modelIds: [modelId],
        timeoutMs: 45_000,
        maxTokens: 32,
      },
    });
  };

  const toggleFavorite = (modelId: string) => {
    const ref = `${providerId}/${modelId}`;
    const exists = isModelInFavorites(providerId, modelId, localPrefs.favoriteModels);
    const favoriteModels = exists
      ? localPrefs.favoriteModels.filter(
          (candidate) => !isModelInFavorites(providerId, modelId, [candidate]),
        )
      : [...localPrefs.favoriteModels, ref];
    localPrefs.set({ favoriteModels });
    ws.updatePrefs({ favoriteModels });
  };

  const enableModel = (modelId: string) => {
    const disabledModels = localPrefs.disabledModels.filter(
      (candidate) => !matchesModelRef(candidate, providerId, modelId, activeProvider),
    );
    localPrefs.set({ disabledModels });
    ws.updatePrefs({ disabledModels });
  };

  const confirmDisable = () => {
    if (disableTargets.length === 0) return;
    const modelIds = new Set(disableTargets.map((target) => target.modelId));
    const disabledModels = [...localPrefs.disabledModels];
    for (const modelId of modelIds) {
      if (!isModelDisabled(providerId, modelId, disabledModels)) {
        disabledModels.push(`${providerId}/${modelId}`);
      }
    }
    const keep = (candidate: string) =>
      ![...modelIds].some((modelId) =>
        matchesModelRef(candidate, providerId, modelId, activeProvider),
      );
    const favoriteModels = localPrefs.favoriteModels.filter(keep);
    const fallbackModels = localPrefs.fallbackModels.filter(keep);
    const fallbackProfiles = Object.fromEntries(
      Object.entries(localPrefs.fallbackProfiles).map(([name, chain]) => [
        name,
        chain.filter(keep),
      ]),
    );
    const patch = { disabledModels, favoriteModels, fallbackModels, fallbackProfiles };
    localPrefs.set(patch);
    ws.updatePrefs(patch);
    setSelected((current) => {
      const next = new Set(current);
      for (const modelId of modelIds) next.delete(modelId);
      return next;
    });
    setDisableTargets([]);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-border/70 px-4 py-3 sm:px-6">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <FlaskConical className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold">Provider Test</h1>
          <p className="truncate text-xs text-muted-foreground">
            Test every selected model with the saved account and its real provider adapter.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => openMainView('settings')}>
          <Settings className="mr-1.5 h-4 w-4" /> Settings
        </Button>
        <Button variant="ghost" size="icon" onClick={() => showPanel('chat')} aria-label="Close">
          <ArrowLeft className="h-4 w-4" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl space-y-5 p-4 sm:p-6">
          <div className="grid grid-cols-3 gap-2 text-xs">
            {(['provider', 'models', 'results'] as const).map((item, index) => (
              <div
                key={item}
                className={cn(
                  'rounded-lg border px-3 py-2',
                  step === item
                    ? 'border-primary/50 bg-primary/10 text-primary'
                    : 'text-muted-foreground',
                )}
              >
                {index + 1}.{' '}
                {item === 'provider' ? 'Account' : item === 'models' ? 'Models' : 'Results'}
              </div>
            ))}
          </div>

          {step === 'provider' && (
            <section className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold">Choose a provider or subscription</h2>
                <p className="text-sm text-muted-foreground">
                  Only saved accounts are shown. Credentials remain on the server.
                </p>
              </div>
              {providers.length === 0 ? (
                <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                  No saved provider accounts. Add one in Settings first.
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {providers.map((provider) => {
                    const activeKey = provider.apiKeys.find((key) => key.isActive);
                    return (
                      <button
                        key={provider.id}
                        type="button"
                        onClick={() => setProviderId(provider.id)}
                        className={cn(
                          'rounded-xl border p-4 text-left transition-colors hover:bg-accent/50',
                          providerId === provider.id &&
                            'border-primary bg-primary/5 ring-1 ring-primary/30',
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="font-medium">{provider.id}</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {provider.type && provider.type !== provider.id
                                ? `${provider.type} · ${provider.family ?? 'auto'}`
                                : (provider.family ?? provider.type ?? 'auto-detect')}
                            </div>
                          </div>
                          <KeyRound className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="mt-3 text-xs text-muted-foreground">
                          {activeKey
                            ? `${activeKey.label} · ${activeKey.maskedKey}`
                            : `${provider.apiKeys.length} saved credential(s)`}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="flex justify-end">
                <Button disabled={!providerId} onClick={openModels}>
                  Next <ChevronRight className="ml-1.5 h-4 w-4" />
                </Button>
              </div>
            </section>
          )}

          {step === 'models' && (
            <section className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Choose models</h2>
                  <p className="text-sm text-muted-foreground">{providerId}</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setSelected(
                        new Set(
                          models
                            .filter(
                              (model) =>
                                !isModelDisabled(providerId, model.id, localPrefs.disabledModels),
                            )
                            .map((model) => model.id),
                        ),
                      )
                    }
                  >
                    Select all
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSelected(new Set(models.map((model) => model.id)))}
                  >
                    With disabled models
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>
                    Clear
                  </Button>
                </div>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="pl-9"
                  placeholder="Filter models…"
                />
              </div>
              {loadingModels ? (
                <div className="flex justify-center p-12">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border">
                  {visibleModels.map((model) => (
                    <label
                      key={model.id}
                      className="flex cursor-pointer items-start gap-3 border-b p-3 last:border-b-0 hover:bg-accent/40"
                    >
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 accent-primary"
                        checked={selected.has(model.id)}
                        onChange={() =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (next.has(model.id)) next.delete(model.id);
                            else next.add(model.id);
                            return next;
                          })
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm">{model.id}</span>
                          {isModelDisabled(providerId, model.id, localPrefs.disabledModels) && (
                            <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                              Disabled
                            </span>
                          )}
                        </div>
                        {model.description && (
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                            {model.description}
                          </p>
                        )}
                      </div>
                      <div className="shrink-0 text-right text-xs text-muted-foreground">
                        <div>ctx {compactNumber(model.contextWindow)}</div>
                        <div>out {compactNumber(model.maxOutput)}</div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
              <div className="flex items-center justify-between">
                <Button variant="ghost" onClick={() => setStep('provider')}>
                  <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
                </Button>
                <Button disabled={selected.size === 0 || loadingModels} onClick={runTests}>
                  <Play className="mr-1.5 h-4 w-4" /> Test {selected.size} model(s)
                </Button>
              </div>
            </section>
          )}

          {step === 'results' && (
            <section className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Test results</h2>
                  <p className="text-sm text-muted-foreground">
                    {providerId} · {tested}/{selected.size} completed
                  </p>
                </div>
                <div className="flex gap-2">
                  {running ? (
                    <Button variant="destructive" size="sm" onClick={cancel}>
                      <CircleStop className="mr-1.5 h-4 w-4" /> Stop
                    </Button>
                  ) : (
                    <>
                      {disableCandidates.length > 1 && (
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setDisableTargets(disableCandidates)}
                        >
                          <Ban className="mr-1.5 h-4 w-4" /> Disable all failed (
                          {disableCandidates.length})
                        </Button>
                      )}
                      <Button variant="outline" size="sm" onClick={() => setStep('models')}>
                        <RotateCcw className="mr-1.5 h-4 w-4" /> Test again
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border p-4">
                  <div className="text-2xl font-semibold">{tested}</div>
                  <div className="text-xs text-muted-foreground">Completed</div>
                </div>
                <div className="rounded-xl border border-success/30 bg-success/5 p-4">
                  <div className="text-2xl font-semibold text-success">{passed}</div>
                  <div className="text-xs text-muted-foreground">Working</div>
                </div>
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
                  <div className="text-2xl font-semibold text-destructive">{failed}</div>
                  <div className="text-xs text-muted-foreground">Failed</div>
                </div>
              </div>
              {runError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  {runError}
                </div>
              )}
              <div className="overflow-x-auto rounded-xl border">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="bg-muted/50 text-xs text-muted-foreground">
                    <tr>
                      <th className="p-3">Model</th>
                      <th className="p-3">Status</th>
                      <th className="p-3">Family / wire</th>
                      <th className="p-3">Catalog limits / cost</th>
                      <th className="p-3">Latency</th>
                      <th className="p-3">Usage</th>
                      <th className="p-3">Detail</th>
                      <th className="p-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((result) => (
                      <tr key={result.modelId} className="border-t align-top">
                        <td className="p-3 font-mono text-xs">{result.modelId}</td>
                        <td className="p-3">
                          {result.status === 'passed' ? (
                            <span className="inline-flex items-center gap-1 text-success">
                              <CheckCircle2 className="h-4 w-4" /> Working
                            </span>
                          ) : result.status === 'cancelled' ? (
                            <span className="text-muted-foreground">Cancelled</span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-destructive">
                              <XCircle className="h-4 w-4" /> Failed
                            </span>
                          )}
                        </td>
                        <td className="p-3 text-xs">
                          <div>{result.family ?? '—'}</div>
                          <div className="text-muted-foreground">{result.wire ?? '—'}</div>
                        </td>
                        <td className="p-3 text-xs">
                          <div>ctx {compactNumber(result.maxContext)}</div>
                          <div>out {compactNumber(result.maxOutput)}</div>
                          {(result.inputCost !== undefined || result.outputCost !== undefined) && (
                            <div className="text-muted-foreground">
                              ${result.inputCost ?? '—'} / ${result.outputCost ?? '—'}
                            </div>
                          )}
                        </td>
                        <td className="p-3 tabular-nums">{result.latencyMs} ms</td>
                        <td className="p-3 text-xs tabular-nums">
                          {result.usage
                            ? `in ${result.usage.input} / out ${result.usage.output}`
                            : '—'}
                        </td>
                        <td className="max-w-sm p-3 text-xs">
                          <div
                            className={
                              result.status === 'failed' ? 'font-medium text-destructive' : ''
                            }
                          >
                            {result.status === 'passed'
                              ? result.stopReason
                              : diagnosisLabel(result.diagnosis)}
                          </div>
                          {result.error && (
                            <div className="mt-1 break-words text-muted-foreground">
                              {result.httpStatus ? `HTTP ${result.httpStatus} · ` : ''}
                              {result.error}
                            </div>
                          )}
                        </td>
                        <td className="p-3">
                          <div className="flex flex-wrap gap-2">
                            {result.status === 'failed' && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={running || Boolean(retryingModel)}
                                onClick={() => retryModel(result.modelId)}
                              >
                                {retryingModel === result.modelId ? (
                                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                                )}
                                Retry
                              </Button>
                            )}
                            {result.status === 'passed' ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => toggleFavorite(result.modelId)}
                              >
                                <Star
                                  className={cn(
                                    'mr-1.5 h-3.5 w-3.5',
                                    isModelInFavorites(
                                      providerId,
                                      result.modelId,
                                      localPrefs.favoriteModels,
                                    ) && 'fill-current text-warning',
                                  )}
                                />
                                {isModelInFavorites(
                                  providerId,
                                  result.modelId,
                                  localPrefs.favoriteModels,
                                )
                                  ? 'Unfavorite'
                                  : 'Favorite'}
                              </Button>
                            ) : result.status === 'failed' ? (
                              isModelDisabled(
                                providerId,
                                result.modelId,
                                localPrefs.disabledModels,
                              ) ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => enableModel(result.modelId)}
                                >
                                  Enable
                                </Button>
                              ) : (
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  onClick={() => setDisableTargets([result])}
                                >
                                  <Ban className="mr-1.5 h-3.5 w-3.5" /> Disable
                                </Button>
                              )
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {running && tested < selected.size && (
                      <tr className="border-t">
                        <td colSpan={8} className="p-4 text-center text-sm text-muted-foreground">
                          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                          Testing next model…
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </div>
      <Dialog
        open={disableTargets.length > 0}
        onOpenChange={(open) => !open && setDisableTargets([])}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {disableTargets.length > 1
                ? `Disable ${disableTargets.length} failed models?`
                : 'Disable this model?'}
            </DialogTitle>
            <DialogDescription>
              {disableTargets.length > 0
                ? `${disableTargets.map((target) => `${providerId}/${target.modelId}`).join(', ')} will be hidden from model pickers and removed from favorites, the explicit fallback chain, and every fallback profile.`
                : ''}
              {disableTargets.some(
                (target) =>
                  providerId === activeProvider &&
                  target.modelId === useConfigStore.getState().model,
              )
                ? ' It is currently active and will remain active until you switch models.'
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisableTargets([])}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDisable}>
              Disable model
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
