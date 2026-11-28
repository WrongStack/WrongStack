import { GitHubView } from '@wrongstack/project-surfaces/github/GitHubView';
import { useMemo } from 'react';
import { desktopSurfaceHost } from './desktop-surface-host';
import type { EngineHttp } from './engine-http';
import { backendStream } from './engine-stream';
import {
  DesktopGitHubHandOff,
  GitHubHandOffContext,
  type GitHubHandOffTargets,
} from './github-hand-off';
import { journalTail } from './journal-tail';
import { SurfaceFrame, useSurfaceConfirm } from './SurfaceFrame';

/**
 * The project's GitHub pull requests and issues, the WebUI's surface. Its
 * requests go through the project engine, whose bridge names the engine's own
 * session (so the project) and carries the access token; agent hand-offs land
 * in a project conversation the user picks.
 */
export function ProjectGitHub({
  projectId,
  http,
  ...targets
}: { projectId: string; http: EngineHttp } & GitHubHandOffTargets) {
  const confirm = useSurfaceConfirm();
  const host = useMemo(() => {
    const base = desktopSurfaceHost(
      backendStream('project', projectId),
      journalTail(projectId),
      http,
      confirm.confirm,
    ).host;
    return { ...base, github: { useSessionId: () => null, HandOff: DesktopGitHubHandOff } };
  }, [projectId, http, confirm.confirm]);
  return (
    <GitHubHandOffContext.Provider value={targets}>
      <SurfaceFrame host={host} confirm={confirm} fill>
        <GitHubView />
      </SurfaceFrame>
    </GitHubHandOffContext.Provider>
  );
}
