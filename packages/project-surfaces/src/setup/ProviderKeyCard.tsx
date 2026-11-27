import { Check, ChevronDown, ChevronRight, ExternalLink, Loader2 } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ProviderLogo } from '../ui/ProviderLogo';
import { useSetupHost } from './feed';
import { waitForKeyOperationResult } from './key-operation';
import type { PopularProvider } from './popular-providers';
import type { CatalogProvider, ProbeResult, SavedProvider } from './types';

export function ProviderKeyCard({
  popular,
  catalogProvider,
  savedProvider,
  onKeySaved,
  probeResult,
}: {
  popular: PopularProvider;
  catalogProvider?: CatalogProvider | undefined;
  savedProvider?: SavedProvider | undefined;
  onKeySaved: (providerId: string) => void;
  probeResult?: ProbeResult | 'probing' | undefined;
}) {
  const { t } = useAppTranslation();
  const host = useSetupHost();
  const ws = host.useClient();
  const toast = host.notify;
  const [key, setKey] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(!!savedProvider?.apiKeys.some((k) => k.isActive));
  const [showModels, setShowModels] = useState(false);
  const savingRef = useRef(false);
  const saveAbortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      saveAbortRef.current?.abort();
    },
    [],
  );

  const handleSave = async () => {
    if (!key.trim() || !ws || savingRef.current) return;
    savingRef.current = true;
    const controller = new AbortController();
    saveAbortRef.current = controller;
    setIsSaving(true);
    try {
      const ack = waitForKeyOperationResult(ws, 8000, controller.signal);
      // If the provider doesn't exist yet in the catalog, add it first.
      // We pass `popular.id` (the canonical preset id, e.g.
      // `kimi-for-coding` or `moonshotai`) so the server-side preset
      // hydration can fill baseUrl/models/quirks without us shipping them
      // through the wire.
      if (!catalogProvider) {
        ws.send({
          type: 'provider.add',
          payload: { id: popular.id, family: popular.family, apiKey: key.trim() },
        });
      } else {
        ws.send({
          type: 'key.add',
          payload: { providerId: popular.id, label: 'default', apiKey: key.trim() },
        });
      }
      const result = await ack;
      if (!result.success) throw new Error(result.message);
      setSaved(true);
      setKey('');
      toast.success(t('setup:screen.toasts.keySaved', { name: popular.name }));
      onKeySaved(popular.id);
      // Re-fetch saved providers to pick up preset-hydrated fields
      // (baseUrl, models, quirks) that the server baked into the config
      // during upsertKey — the broadcast may race with the ack, so an
      // explicit fetch guarantees the UI sees the canonical state.
      ws.send({ type: 'providers.saved' });
      // Auto-probe the saved endpoint to validate the key works and
      // discover available models — the result arrives asynchronously
      // and is displayed inline when `probeResult` updates.
      ws.send({ type: 'provider.probe', payload: { providerId: popular.id } });
    } catch (err) {
      if (controller.signal.aborted) return;
      const detail =
        err instanceof Error && err.message && err.message !== 'timeout' ? err.message : null;
      toast.error(detail ?? t('setup:screen.toasts.keySaveFailed', { name: popular.name }));
    } finally {
      savingRef.current = false;
      if (saveAbortRef.current === controller) saveAbortRef.current = null;
      if (!controller.signal.aborted) setIsSaving(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && key.trim()) {
      handleSave();
    }
  };

  const hasModels = catalogProvider && catalogProvider.modelCount > 0;

  return (
    <div
      className={cn(
        'rounded-xl border p-4 transition-all',
        saved ? 'border-success/30 bg-success/5' : `bg-gradient-to-br ${popular.color}`,
      )}
    >
      <div className="flex items-start gap-3">
        <ProviderLogo
          providerId={popular.id}
          baseUrl={catalogProvider?.apiBase}
          className="h-10 w-10"
        />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{popular.name}</h3>
            {saved && (
              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-success/10 text-success border border-success/20">
                <Check className="h-2.5 w-2.5" />
                {t('setup:screen.card.keySaved')}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{popular.description}</p>

          {!saved ? (
            <div className="mt-3 space-y-2">
              <div className="flex gap-2">
                <Input
                  type="password"
                  placeholder={popular.keyPlaceholder}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="font-mono text-sm"
                />
                <Button
                  onClick={handleSave}
                  disabled={!key.trim() || isSaving}
                  size="sm"
                  className="shrink-0"
                >
                  {isSaving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    t('setup:screen.card.save')
                  )}
                </Button>
              </div>
              {popular.docsUrl && (
                <a
                  href={popular.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t('setup:screen.card.getKey')} <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          ) : saved ? (
            /* Key saved — show enriched preset fields from the server */
            <div className="mt-3 space-y-1">
              {savedProvider?.baseUrl && (
                <div
                  className="text-[11px] text-muted-foreground/70 font-mono truncate"
                  title={savedProvider.baseUrl}
                >
                  <span className="text-muted-foreground/50">{t('activity:providerKey.url')} </span>
                  {savedProvider.baseUrl}
                </div>
              )}
              {savedProvider?.models && savedProvider.models.length > 0 && (
                <div className="text-[11px] text-muted-foreground/70">
                  <span className="text-muted-foreground/50">
                    {t('activity:providerKey.models')}{' '}
                  </span>
                  {savedProvider.pickedModelId ?? savedProvider.models[0]}
                  <span className="text-muted-foreground/50">
                    {' '}
                    (+{savedProvider.models.length - 1} more)
                  </span>
                </div>
              )}

              {/* Health probe result */}
              {probeResult === 'probing' ? (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t('setup:screen.probe.checking', 'Checking connection…')}
                </div>
              ) : probeResult?.ok ? (
                <div className="flex items-center gap-1.5 text-[11px] text-success mt-1">
                  <Check className="h-3 w-3" />
                  <span>
                    {t('setup:screen.probe.connected', 'Connected')}
                    {probeResult.modelCount != null &&
                      ` · ${probeResult.modelCount} ${t('setup:screen.probe.models', 'models')}`}
                    {probeResult.elapsedMs != null && ` · ${probeResult.elapsedMs}ms`}
                  </span>
                </div>
              ) : probeResult && !probeResult.ok ? (
                <div className="flex items-start gap-1.5 text-[11px] text-destructive mt-1">
                  <span className="mt-0.5 shrink-0">✕</span>
                  <div className="min-w-0">
                    <span className="font-medium">
                      {t('setup:screen.probe.failed', 'Probe failed')}
                    </span>
                    {probeResult.status === 'no_base_url' && (
                      <span className="block text-destructive/70">
                        {t('setup:screen.probe.noBaseUrl', 'No base URL configured')}
                      </span>
                    )}
                    {probeResult.status === 'unreachable' && (
                      <span className="block text-destructive/70">
                        {t('setup:screen.probe.unreachable', 'Could not connect')}
                        {probeResult.detail ? `: ${probeResult.detail}` : ''}
                      </span>
                    )}
                    {probeResult.status !== 'no_base_url' &&
                      probeResult.status !== 'unreachable' && (
                        <>
                          <span className="block text-destructive/70">
                            {probeResult.httpStatus != null
                              ? `${t('setup:screen.probe.httpStatus', 'Status')} ${probeResult.httpStatus}`
                              : probeResult.status}
                          </span>
                          {probeResult.detail && (
                            <span
                              className="block text-destructive/70 truncate max-w-[250px]"
                              title={probeResult.detail}
                            >
                              {probeResult.detail}
                            </span>
                          )}
                        </>
                      )}
                  </div>
                </div>
              ) : null}

              {hasModels && (
                <button
                  type="button"
                  onClick={() => setShowModels(!showModels)}
                  className="text-[11px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                >
                  {t('setup:screen.providers.modelsAvailable', {
                    count: catalogProvider?.modelCount ?? 0,
                  })}
                  {showModels ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                </button>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── Setup Screen ──────────────────────────────────────────────────────────────
