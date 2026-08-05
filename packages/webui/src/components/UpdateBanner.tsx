import { X, ArrowUpCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSessionStore } from '@/stores';
import { useAppTranslation } from '@/i18n';

/**
 * Prominent "Update available" banner shown at the top of the WebUI when
 * the running WrongStack version is older than the latest published npm
 * release. Dismissable (X button) — once dismissed it stays hidden until
 * the next `session.start` with version info (F5, reconnect).
 */
export function UpdateBanner() {
  const { t } = useAppTranslation();
  const appVersion = useSessionStore((s) => s.appVersion);
  const latestVersion = useSessionStore((s) => s.latestVersion);
  const updateAvailable = useSessionStore((s) => s.updateAvailable);
  const [dismissed, setDismissed] = useState(false);

  // Re-show the banner whenever update info refreshes (F5 / reconnect).
  useEffect(() => {
    if (updateAvailable) setDismissed(false);
  }, [appVersion, latestVersion, updateAvailable]);

  if (!updateAvailable || !latestVersion || dismissed) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b text-sm bg-warning/10 text-warning border-warning/30">
      <ArrowUpCircle className="h-4 w-4 shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="font-medium">
          Update available: v{appVersion || '?'} → v{latestVersion}
        </span>
        <span className="ml-2 text-xs opacity-80">
          {t('activity:updateBanner.run')} <code className="font-mono text-[inherit]">{t('activity:updateBanner.wstackUpdate')}</code> {t('activity:updateBanner.orYourPackageManagerToUpgrade')}
        </span>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="text-current/60 hover:text-current shrink-0 p-0.5 rounded"
        title={t('activity:updateBanner.dismiss')}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
