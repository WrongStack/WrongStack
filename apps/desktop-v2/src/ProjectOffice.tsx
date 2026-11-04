import { OfficeWorkspace } from '@wrongstack/project-surfaces/office/OfficeWorkspace';
import { useEffect, useMemo } from 'react';
import { desktopOfficeFeed } from './desktop-office-feed';
import { desktopSurfaceHost } from './desktop-surface-host';
import type { EngineHttp } from './engine-http';
import { backendStream } from './engine-stream';
import { journalTail } from './journal-tail';
import { MarkdownContent } from './MarkdownContent';
import { isLive, type Project, type Session } from './model';
import {
  EMPTY_OFFICE_FLEET,
  mergeOfficeFleet,
  type OfficeFleet,
  officeFleetParts,
} from './office-fleet';
import { openExternal } from './platform';
import { SurfaceFrame, useSurfaceConfirm } from './SurfaceFrame';

/**
 * Keeps the readers of a project's live conversations running while the office is open, and
 * calls `onChange` with their merged fleet whenever one of them changes it. Read errors stay
 * with the conversation views that report them.
 */
function watchOfficeFleet(
  sessionIds: readonly string[],
  onChange: (fleet: OfficeFleet) => void,
): () => void {
  const streams = sessionIds.map((id) => backendStream('engine', id));
  let seen: unknown[] = [];
  const changed = () => {
    const parts = streams.flatMap(({ state }) => officeFleetParts(state));
    if (parts.length === seen.length && parts.every((part, index) => part === seen[index])) return;
    seen = parts;
    onChange(mergeOfficeFleet(streams.map((stream) => stream.state)));
  };
  const offs = streams.map((stream) => stream.subscribe({ changed, onError: () => undefined }));
  changed();
  return () => {
    for (const off of offs) off();
  };
}

function OfficeMarkdown({ children }: { children: string }) {
  return <MarkdownContent text={children} onLink={(url) => void openExternal(url)} />;
}

/**
 * A project's agent office: the WebUI's office map (desks, break room, briefing and the
 * topology canvas) with its display settings, fed by this project's session registry and
 * mailbox, and by the fleets of its live conversations.
 */
export function ProjectOffice({
  project,
  sessions,
  http,
}: {
  project: Project;
  sessions: readonly Session[];
  http: EngineHttp;
}) {
  const { id: projectId, name: projectName } = project;
  const confirm = useSurfaceConfirm();
  const surface = useMemo(() => {
    const base = desktopSurfaceHost(
      backendStream('project', projectId),
      journalTail(projectId),
      http,
      confirm.confirm,
    );
    const office = desktopOfficeFeed({
      client: base.host.getClient(),
      send: base.send,
      projectName,
      pingFleet: () => http('/api/fleet/ping', 'POST', {}),
    });
    return {
      host: { ...base.host, office: office.feed, Markdown: OfficeMarkdown },
      attach: base.attach,
      start: office.start,
      setFleet: office.setFleet,
    };
  }, [projectId, projectName, http, confirm.confirm]);
  useEffect(() => {
    const detach = surface.attach();
    const stop = surface.start();
    return () => {
      stop();
      detach();
    };
  }, [surface]);
  const live = sessions
    .filter(
      (session) => session.projectId === projectId && session.kind === 'agent' && isLive(session),
    )
    .map((session) => session.id)
    .join('\n');
  useEffect(() => {
    if (live) return watchOfficeFleet(live.split('\n'), surface.setFleet);
    surface.setFleet(EMPTY_OFFICE_FLEET);
    return undefined;
  }, [live, surface]);
  return (
    <SurfaceFrame host={surface.host} confirm={confirm} fill>
      <OfficeWorkspace fill />
    </SurfaceFrame>
  );
}
