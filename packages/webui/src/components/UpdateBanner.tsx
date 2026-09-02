import { ArrowUpCircle, RefreshCw, Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSessionStore } from '@/stores';
import { useAppTranslation } from '@/i18n';

const CACHE_VERSION_KEY = 'wrongstack_app_cached_version';

/**
 * Prominent "Update available / New build ready" banner shown at the top of the WebUI.
 *
 * Handles:
 * 1. PWA & version-based cache clearing: when a new server build/version is detected,
 *    clears browser caches and offers a 1-click refresh.
 * 2. NPM release updates: alerts when a newer version is published on npm.
 */
export function UpdateBanner() {
  const { t } = useAppTranslation();
  const appVersion = useSessionStore((s) => s.appVersion);
  const latestVersion = useSessionStore((s) => s.latestVersion);
  const updateAvailable = useSessionStore((s) => s.updateAvailable);

  const [dismissed, setDismissed] = useState(false);
  const [newBuildDetected, setNewBuildDetected] = useState(false);

  // Version-based cache invalidation for PWA and long-lived sessions
  useEffect(() => {
    if (!appVersion) return;
    try {
      const stored = localStorage.getItem(CACHE_VERSION_KEY);
      if (!stored) {
        localStorage.setItem(CACHE_VERSION_KEY, appVersion);
      } else if (stored !== appVersion) {
        // App version changed — invalidate browser cache storage
        if (typeof window !== 'undefined' && 'caches' in window) {
          window.caches.keys().then((names) => {
            for (const name of names) {
              window.caches.delete(name);
            }
          });
        }
        setNewBuildDetected(true);
        localStorage.setItem(CACHE_VERSION_KEY, appVersion);
      }
    } catch {
      // Ignore localStorage access errors (e.g. sandboxed iframe)
    }
  }, [appVersion]);

  // Re-show the banner whenever update info refreshes
  useEffect(() => {
    if (updateAvailable || newBuildDetected) setDismissed(false);
  }, [appVersion, latestVersion, updateAvailable, newBuildDetected]);

  const handleRefresh = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  const shouldShow =
    !dismissed && (newBuildDetected || (updateAvailable && Boolean(latestVersion)));
  if (!shouldShow) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b text-sm bg-warning/10 text-warning border-warning/30 backdrop-blur-md">
      {newBuildDetected ? (
        <Sparkles className="h-4 w-4 shrink-0 text-primary" />
      ) : (
        <ArrowUpCircle className="h-4 w-4 shrink-0" />
      )}

      <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1">
        {newBuildDetected ? (
          <span className="font-medium text-foreground">
            {t('activity:updateBanner.newBuildReady', 'New build ready. Cache cleared.')} (v
            {appVersion})
          </span>
        ) : (
          <>
            <span className="font-medium">
              Update available: v{appVersion || '?'} → v{latestVersion}
            </span>
            <span className="text-xs opacity-80">
              {t('activity:updateBanner.run')}{' '}
              <code className="font-mono text-[inherit]">
                {t('activity:updateBanner.wstackUpdate')}
              </code>{' '}
              {t('activity:updateBanner.orYourPackageManagerToUpgrade')}
            </span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={handleRefresh}
          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-warning/20 hover:bg-warning/30 text-warning text-xs font-medium transition-colors"
          title={t('activity:updateBanner.refresh', 'Refresh')}
        >
          <RefreshCw className="h-3 w-3" />
          <span>{t('activity:updateBanner.refresh', 'Refresh')}</span>
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="text-current/60 hover:text-current p-1 rounded hover:bg-warning/20 transition-colors"
          title={t('activity:updateBanner.dismiss')}
          aria-label={t('activity:updateBanner.dismiss')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
