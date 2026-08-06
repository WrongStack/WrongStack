import { Eye } from 'lucide-react';
import type { ReactElement } from 'react';
import { useAppTranslation } from '@/i18n';

/**
 * Shadow agent — informational only.
 *
 * This panel used to render Start / Stop buttons and a green "Running" badge
 * driven entirely by local `useState`: `handleStart` set `running = true` and
 * `shadowId = 'pending'` and did nothing else. No WS message was sent, no
 * shadow agent existed, nothing monitored the fleet, and a page refresh
 * silently reset the badge — a fabricated "Running" state in a security panel.
 * (The file's own comment admitted it: "Since there's no WS message for shadow
 * start, we'll use a simple approach".)
 *
 * There is genuinely no `shadow.*` message in the client protocol registry, so
 * the panel cannot control it. Until one exists, point at the surface that
 * can: the `/shadow` slash command. Adding the protocol surface is a real
 * change — registry entry, server handler, and the pinned contract counts —
 * not something to fake here.
 */
export function ShadowSection(): ReactElement {
  const { t } = useAppTranslation();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Eye className="h-5 w-5 text-info" />
        <h3 className="text-lg font-semibold">{t('activity:shadow.shadowAgent')}</h3>
      </div>

      <p className="text-sm text-muted-foreground">
        {t('activity:shadow.theShadowAgentMonitorsAllFleet')}
      </p>

      <p className="text-sm text-muted-foreground">
        Start and stop it from the chat with{' '}
        <code className="font-mono text-xs">/shadow start</code> and{' '}
        <code className="font-mono text-xs">/shadow stop</code>. This panel cannot control it yet.
      </p>
    </div>
  );
}
