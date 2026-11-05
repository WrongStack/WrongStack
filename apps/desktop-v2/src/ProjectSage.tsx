import { SageTabs } from '@wrongstack/project-surfaces/sage';
import { useEffect, useMemo } from 'react';
import { desktopSurfaceHost } from './desktop-surface-host';
import type { EngineHttp } from './engine-http';
import { backendStream } from './engine-stream';
import { journalTail } from './journal-tail';
import { SurfaceFrame, useSurfaceConfirm } from './SurfaceFrame';

/**
 * A project's SAGE memory: the WebUI's own memory surface (library, relationship graph, review
 * queue, health, audience and vector lenses), running on this project's engine.
 */
export function ProjectSage({
  projectId,
  http,
  initialMemoryId,
}: {
  projectId: string;
  http: EngineHttp;
  initialMemoryId?: string | undefined;
}) {
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
  useEffect(() => attach(), [attach]);
  return (
    // The WebUI's SAGE workbench fills its panel and scrolls its own lists, as Kanban and Atlas
    // do; without `fill` the project page's padding framed it with empty margins.
    <SurfaceFrame host={host} confirm={confirm} fill>
      <SageTabs key={initialMemoryId ?? ''} linkedMemoryId={initialMemoryId} />
    </SurfaceFrame>
  );
}
