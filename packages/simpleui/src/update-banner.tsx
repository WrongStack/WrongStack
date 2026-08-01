import { ArrowUpCircle, X } from 'lucide-react';

export interface UpdateBannerProps {
  appVersion: string;
  latestVersion: string;
  /**
   * Whether a genuine newer version is available. Computed once by the
   * caller — the same gate drives the persistent topbar version chip, so
   * the banner and the chip can never diverge on the upgrade condition.
   */
  show: boolean;
  onDismiss: () => void;
}

/**
 * Dismissible "update available" call-to-action banner.
 *
 * Extracted from `simple-ui-session.tsx` (plan B1 slice 5). Purely
 * presentational: the caller owns the update state and the `hasUpdate`
 * gate. Dismissal only hides the banner — the caller's `onDismiss`
 * preserves `appVersion` so the persistent topbar version chip stays
 * visible ("visible at all times" contract, matching the WebUI sibling
 * `UpdateBanner.tsx`).
 */
export function UpdateBanner({ appVersion, latestVersion, show, onDismiss }: UpdateBannerProps) {
  if (!show) return null;
  return (
    <div className="update-banner">
      <ArrowUpCircle size={15} />
      <span>
        Update available: v{appVersion || '?'} → v{latestVersion}
        {' · '}
        <code>wstack update</code>
      </span>
      <button
        type="button"
        className="update-banner-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss update warning"
      >
        <X size={14} />
      </button>
    </div>
  );
}
