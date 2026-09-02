import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Gift,
  Loader2,
  Share2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { toast } from '@/components/Toaster';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useConfigStore } from '@/stores';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
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
  catalogProvider?: CatalogProvider;
  savedProvider?: SavedProvider;
  onKeySaved: (providerId: string) => void;
  probeResult?: ProbeResult | 'probing' | undefined;
}) {
  const { t } = useAppTranslation();
  const [key, setKey] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(!!savedProvider?.apiKeys.some((k) => k.isActive));
  const [showModels, setShowModels] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // Generate QR code when modal opens
  useEffect(() => {
    if (shareModalOpen && popular.referral) {
      QRCode.toDataURL(popular.referral!.url, {
        width: 200,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      })
        .then((url: string) => setQrDataUrl(url))
        .catch(() => setQrDataUrl(null));
    }
  }, [shareModalOpen, popular.referral]);

  const handleSave = async () => {
    if (!key.trim()) return;
    setIsSaving(true);
    try {
      const ws = getWSClient(useConfigStore.getState().wsUrl);
      const ack = waitForKeyOperationResult(ws);
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
        ws.addKey(popular.id, 'default', key.trim());
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
      ws.listSavedProviders();
      // Auto-probe the saved endpoint to validate the key works and
      // discover available models — the result arrives asynchronously
      // and is displayed inline when `probeResult` updates.
      ws.probeProvider(popular.id);
    } catch (err) {
      const detail =
        err instanceof Error && err.message && err.message !== 'timeout' ? err.message : null;
      toast.error(detail ?? t('setup:screen.toasts.keySaveFailed', { name: popular.name }));
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && key.trim()) {
      handleSave();
    }
  };

  const handleCopyReferral = async () => {
    if (!popular.referral) return;
    try {
      await navigator.clipboard.writeText(popular.referral!.url);
      setCopied(true);
      toast.success(t('setup:screen.toasts.referralCopied'));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('setup:screen.toasts.referralCopyFailed'));
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
        <span className="text-2xl shrink-0 mt-0.5">{popular.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{popular.name}</h3>
            {saved && (
              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-success/10 text-success border border-success/20">
                <Check className="h-2.5 w-2.5" />
                {t('setup:screen.card.keySaved')}
              </span>
            )}
            {popular.referral && !saved && (
              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-warning/10 text-warning border border-warning/20">
                <Gift className="h-2.5 w-2.5" />
                {t('setup:screen.card.referral')}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{popular.description}</p>
          {popular.referral && !saved && (
            <p className="text-[11px] text-warning/80 mt-1">🎁 {popular.referral!.reward}</p>
          )}

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
              {popular.referral && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCopyReferral}
                    className="inline-flex items-center gap-1 text-[11px] text-warning/80 hover:text-warning transition-colors"
                  >
                    {copied ? (
                      <>
                        <Check className="h-3 w-3" /> {t('setup:screen.card.copied')}
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" /> {t('setup:screen.card.copyReferral')}
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShareModalOpen(true)}
                    className="inline-flex items-center gap-1 text-[11px] text-warning/80 hover:text-warning transition-colors"
                  >
                    <Share2 className="h-3 w-3" /> {t('setup:screen.card.share')}
                  </button>
                </div>
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

      {/* Share Modal */}
      <Dialog open={shareModalOpen} onOpenChange={setShareModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Gift className="h-4 w-4 text-warning" />
              {t('setup:screen.share.title', { name: popular.name })}
            </DialogTitle>
            <DialogDescription>{t('setup:screen.share.description')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-4">
            {popular.referral && (
              <>
                <div className="text-sm text-center">
                  <p className="font-medium text-warning">🎁 {popular.referral!.reward}</p>
                </div>
                {qrDataUrl ? (
                  <div className="rounded-lg border border-border p-2 bg-white">
                    <img
                      src={qrDataUrl}
                      alt={t('setup:screen.card.qrAlt', { name: popular.name })}
                      className="w-[200px] h-[200px]"
                    />
                  </div>
                ) : (
                  <div className="w-[200px] h-[200px] rounded-lg border border-border flex items-center justify-center bg-muted">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                )}
                <div className="w-full space-y-2">
                  {/* Social Media Share Buttons */}
                  <div className="flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const text = encodeURIComponent(
                          `Check out ${popular.name}! 🎁 ${popular.referral!.reward}`,
                        );
                        const url = encodeURIComponent(popular.referral!.url);
                        window.open(
                          `https://twitter.com/intent/tweet?text=${text}&url=${url}`,
                          '_blank',
                          'noopener,noreferrer',
                        );
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-card text-xs text-foreground hover:bg-muted transition-colors"
                      title={t('setup:screen.share.twitter')}
                    >
                      <svg
                        role="img"
                        aria-hidden="true"
                        className="h-3.5 w-3.5"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                      </svg>
                      X
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const url = encodeURIComponent(popular.referral!.url);
                        const summary = encodeURIComponent(
                          `Check out ${popular.name}! ${popular.referral!.reward}`,
                        );
                        window.open(
                          `https://www.linkedin.com/sharing/share-offsite/?url=${url}&summary=${summary}`,
                          '_blank',
                          'noopener,noreferrer',
                        );
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-card text-xs text-foreground hover:bg-muted transition-colors"
                      title={t('setup:screen.share.linkedin')}
                    >
                      <svg
                        role="img"
                        aria-hidden="true"
                        className="h-3.5 w-3.5"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                      </svg>
                      {t('activity:providerKey.linkedin')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const text = encodeURIComponent(
                          `Check out ${popular.name}! 🎁 ${popular.referral!.reward} ${popular.referral!.url}`,
                        );
                        window.open(
                          `https://t.me/share/url?url=${text}`,
                          '_blank',
                          'noopener,noreferrer',
                        );
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-card text-xs text-foreground hover:bg-muted transition-colors"
                      title={t('setup:screen.share.telegram')}
                    >
                      <svg
                        role="img"
                        aria-hidden="true"
                        className="h-3.5 w-3.5"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
                      </svg>
                      {t('activity:providerKey.telegram')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const text = encodeURIComponent(
                          `Check out ${popular.name}! 🎁 ${popular.referral!.reward}`,
                        );
                        const url = encodeURIComponent(popular.referral!.url);
                        window.open(
                          `https://wa.me/?text=${text}%20${url}`,
                          '_blank',
                          'noopener,noreferrer',
                        );
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-card text-xs text-foreground hover:bg-muted transition-colors"
                      title={t('setup:screen.share.whatsapp')}
                    >
                      <svg
                        role="img"
                        aria-hidden="true"
                        className="h-3.5 w-3.5"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.134 1.585 5.934L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
                      </svg>
                      {t('activity:providerKey.whatsapp')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const url = encodeURIComponent(popular.referral!.url);
                        const title = encodeURIComponent(
                          `${popular.name} - ${popular.referral!.reward}`,
                        );
                        window.open(
                          `https://www.reddit.com/submit?url=${url}&title=${title}`,
                          '_blank',
                          'noopener,noreferrer',
                        );
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-card text-xs text-foreground hover:bg-muted transition-colors"
                      title={t('setup:screen.share.reddit')}
                    >
                      <svg
                        role="img"
                        aria-hidden="true"
                        className="h-3.5 w-3.5"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 0 1.108-.701 1.25 1.25 0 0 1 2.144.33zm-8.811 8.748c-.968 0-1.754.786-1.754 1.754 0 .968.786 1.754 1.754 1.754.968 0 1.754-.786 1.754-1.754 0-.968-.786-1.754-1.754-1.754zm7.944 0c-.968 0-1.754.786-1.754 1.754 0 .968.786 1.754 1.754 1.754.968 0 1.754-.786 1.754-1.754 0-.968-.786-1.754-1.754-1.754z" />
                      </svg>
                      {t('activity:providerKey.reddit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const text = encodeURIComponent(
                          `Check out ${popular.name}! 🎁 ${popular.referral!.reward}`,
                        );
                        const url = encodeURIComponent(popular.referral!.url);
                        window.open(
                          `https://www.facebook.com/sharer/sharer.php?u=${url}&quote=${text}`,
                          '_blank',
                          'noopener,noreferrer',
                        );
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-card text-xs text-foreground hover:bg-muted transition-colors"
                      title={t('setup:screen.share.facebook')}
                    >
                      <svg
                        role="img"
                        aria-hidden="true"
                        className="h-3.5 w-3.5"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
                      </svg>
                      {t('activity:providerKey.facebook')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const text = encodeURIComponent(
                          `Check out ${popular.name}! 🎁 ${popular.referral!.reward}`,
                        );
                        const url = encodeURIComponent(popular.referral!.url);
                        window.open(
                          `mailto:?subject=${text}&body=${url}`,
                          '_blank',
                          'noopener,noreferrer',
                        );
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-muted text-muted-foreground text-xs hover:bg-muted/80 transition-colors"
                      title={t('setup:screen.share.email')}
                    >
                      <svg
                        role="img"
                        aria-hidden="true"
                        className="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25H4.5a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75"
                        />
                      </svg>
                      {t('activity:providerKey.email')}
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      value={popular.referral!.url}
                      readOnly
                      className="font-mono text-xs flex-1"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleCopyReferral}
                      className="shrink-0"
                    >
                      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground text-center">
                    {t('setup:screen.share.hint')}
                  </p>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Setup Screen ──────────────────────────────────────────────────────────────
