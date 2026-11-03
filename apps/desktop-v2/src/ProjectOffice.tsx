import { OfficeWorkspace } from '@wrongstack/project-surfaces/office/OfficeWorkspace';
import { useEffect, useMemo } from 'react';
import { desktopOfficeFeed } from './desktop-office-feed';
import { desktopSurfaceHost } from './desktop-surface-host';
import type { EngineHttp } from './engine-http';
import { backendStream } from './engine-stream';
import { journalTail } from './journal-tail';
import { MarkdownContent } from './MarkdownContent';
import { openExternal } from './platform';
import { SurfaceFrame, useSurfaceConfirm } from './SurfaceFrame';

function OfficeMarkdown({ children }: { children: string }) {
  return <MarkdownContent text={children} onLink={(url) => void openExternal(url)} />;
}

/**
 * A project's agent office: the WebUI's office map (desks, break room, briefing and the
 * topology canvas) with its display settings, fed by this project's session registry and
 * mailbox.
 */
export function ProjectOffice({
  projectId,
  projectName,
  http,
}: {
  projectId: string;
  projectName: string;
  http: EngineHttp;
}) {
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
  return (
    <SurfaceFrame host={surface.host} confirm={confirm} fill>
      <OfficeWorkspace fill />
    </SurfaceFrame>
  );
}
