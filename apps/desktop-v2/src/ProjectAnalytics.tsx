import { AnalyticsDashboard } from '@wrongstack/project-surfaces/analytics/AnalyticsDashboard';
import { useEffect, useMemo } from 'react';
import { desktopSurfaceHost } from './desktop-surface-host';
import type { EngineHttp } from './engine-http';
import { backendStream } from './engine-stream';
import { journalTail } from './journal-tail';
import { SurfaceFrame, useSurfaceConfirm } from './SurfaceFrame';

/**
 * The project engine's analytics, the WebUI's dashboard: sessions and their agents, tool calls
 * and iterations, the active conversation's tokens and cost, and the engine's event buffer.
 */
export function ProjectAnalytics({ projectId, http }: { projectId: string; http: EngineHttp }) {
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
      <AnalyticsDashboard />
    </SurfaceFrame>
  );
}
