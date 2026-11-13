import { AnalyticsDashboard } from '@wrongstack/project-surfaces/analytics/AnalyticsDashboard';
import { useEffect, useMemo } from 'react';
import { useDesktopText } from './desktop-i18n';
import { desktopSurfaceHost } from './desktop-surface-host';
import type { EngineHttp } from './engine-http';
import { backendStream } from './engine-stream';
import { journalTail } from './journal-tail';
import { SurfaceFrame, useSurfaceConfirm } from './SurfaceFrame';

/**
 * The project's live analytics, the WebUI's dashboard: the live sessions, their agents, tool
 * calls and iterations. The project engine runs no conversation of its own and the desktop
 * records no interface events, so the dashboard's own-session cost/usage and event sections
 * (zero by construction) are left out; spend per provider and model is in Chronicle.
 */
export function ProjectAnalytics({ projectId, http }: { projectId: string; http: EngineHttp }) {
  const { t } = useDesktopText();
  const confirm = useSurfaceConfirm();
  const { host, attach } = useMemo(
    () =>
      desktopSurfaceHost(
        backendStream('project', projectId),
        journalTail(projectId),
        http,
        confirm.confirm,
      ),
    [projectId, http, confirm.confirm],
  );
  // The stats reply arrives on the journal, which the host reads while the page is open.
  useEffect(() => attach(), [attach]);
  return (
    <SurfaceFrame host={host} confirm={confirm} fill>
      <AnalyticsDashboard heading={t('pages.analytics')} uiEvents={false} hostSession={false} />
    </SurfaceFrame>
  );
}
