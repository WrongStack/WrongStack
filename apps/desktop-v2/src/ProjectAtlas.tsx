import { CodeMap } from '@wrongstack/project-surfaces/atlas/CodeMap';
import { useCodemapActivityStore } from '@wrongstack/project-surfaces/atlas/codemap-activity-store';
import { bindAtlasFrames } from '@wrongstack/project-surfaces/atlas/frames';
import { memo, useEffect, useMemo } from 'react';
import { DESKTOP_ATLAS, DesktopAtlasContext, type DesktopAtlasValue } from './desktop-atlas-host';
import { desktopSurfaceHost } from './desktop-surface-host';
import { type EngineHttp, retryWhileUnavailable } from './engine-http';
import type { EngineCommand, EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import { backendStream } from './engine-stream';
import { journalTail } from './journal-tail';
import { SurfaceFrame, useSurfaceConfirm } from './SurfaceFrame';
import './atlas-tools.css';

/**
 * A project's Code Atlas: the WebUI's own map (code tree, dependency canvas, relation
 * inspector, live agent activity) on this project's engine, with the desktop's index control,
 * subsystem, matrix and impact views, file evidence and code assist added through its host.
 */
export function ProjectAtlas({
  projectId,
  projectRoot,
  http,
  send,
  command,
  state,
  onOpenFile,
  onOpenMemory,
}: {
  projectId: string;
  projectRoot: string;
  http: EngineHttp;
  send: EngineSend;
  command: EngineCommand;
  state: EngineState;
  onOpenFile?: ((path: string) => void) | undefined;
  onOpenMemory?: ((id: string) => void) | undefined;
}) {
  const desktop = useMemo<DesktopAtlasValue>(
    () => ({ projectRoot, http, send, command, state, onOpenFile, onOpenMemory }),
    [projectRoot, http, send, command, state, onOpenFile, onOpenMemory],
  );
  // The engine state changes with every frame; only the host's own panels read it, so the map
  // below renders again only when the project or its connection does.
  return (
    <DesktopAtlasContext.Provider value={desktop}>
      <AtlasFrame projectId={projectId} http={http} />
    </DesktopAtlasContext.Provider>
  );
}

const AtlasFrame = memo(function AtlasFrame({
  projectId,
  http,
}: {
  projectId: string;
  http: EngineHttp;
}) {
  const confirm = useSurfaceConfirm();
  const surface = useMemo(() => {
    // Graph reads wait out an engine that is still starting.
    const base = desktopSurfaceHost(
      backendStream('project', projectId),
      journalTail(projectId),
      retryWhileUnavailable(http),
      confirm.confirm,
    );
    return { host: { ...base.host, atlas: DESKTOP_ATLAS }, attach: base.attach };
  }, [projectId, http, confirm.confirm]);

  // A project shows only its own activity: the store is shared module state.
  useEffect(() => {
    useCodemapActivityStore.getState().clear();
    const detach = surface.attach();
    const unbind = bindAtlasFrames(surface.host.getClient().on);
    return () => {
      unbind();
      detach();
    };
  }, [surface]);

  return (
    <SurfaceFrame host={surface.host} confirm={confirm} fill>
      <div className="atlas-surface">
        <CodeMap />
      </div>
    </SurfaceFrame>
  );
});
