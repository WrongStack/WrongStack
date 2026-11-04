import { DebugDashboard } from '@wrongstack/project-surfaces/diagnostics/DebugDashboard';
import { useMemo } from 'react';
import { ConnectionDiagnostics } from './ConnectionDiagnostics';
import { desktopSurfaceHost } from './desktop-surface-host';
import type { EngineHttp } from './engine-http';
import { backendStream } from './engine-stream';
import { journalTail } from './journal-tail';
import type { Session } from './model';
import { SurfaceFrame, useSurfaceConfirm } from './SurfaceFrame';

/**
 * The project engine's diagnostics, the WebUI's debug dashboard: process memory and heap, CPU,
 * uptime, the codebase-index server, child processes and the file watcher; then the desktop's
 * reconnect diagnostics for the project's conversations.
 */
export function ProjectDiagnostics({
  projectId,
  http,
  sessions,
}: {
  projectId: string;
  http: EngineHttp;
  sessions: readonly Session[];
}) {
  const confirm = useSurfaceConfirm();
  const host = useMemo(
    () =>
      desktopSurfaceHost(
        backendStream('project', projectId),
        journalTail(projectId),
        http,
        confirm.confirm,
      ).host,
    [projectId, http, confirm.confirm],
  );
  return (
    <SurfaceFrame host={host} confirm={confirm} fill>
      <DebugDashboard after={<ConnectionDiagnostics sessions={sessions} />} />
    </SurfaceFrame>
  );
}
