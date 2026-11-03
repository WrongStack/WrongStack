import { SessionStoryView } from '@wrongstack/project-surfaces/story/SessionStoryView';
import { useMemo, useRef } from 'react';
import {
  DesktopStoryContext,
  type DesktopStoryValue,
  desktopStoryFeed,
} from './desktop-story-feed';
import { desktopSurfaceHost } from './desktop-surface-host';
import { projectHttp } from './engine-http';
import type { EngineCommand, EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import { backendStream } from './engine-stream';
import { journalTail } from './journal-tail';
import { SurfaceFrame, useSurfaceConfirm } from './SurfaceFrame';
import './session-story.css';

/**
 * A conversation's story, the WebUI's Session Story view: its lanes, timeline, context, model,
 * tool, file and team dashboards, read from the conversation's Chronicle history.
 */
export function SessionStory({
  projectId,
  projectRoot,
  state,
  send,
  command,
  onBack,
}: {
  projectId: string;
  projectRoot: string;
  state: EngineState;
  send: EngineSend;
  command: EngineCommand;
  onBack: () => void;
}) {
  const value = useMemo<DesktopStoryValue>(
    () => ({ state, projectRoot, send, command, onBack }),
    [state, projectRoot, send, command, onBack],
  );
  const latest = useRef(value);
  latest.current = value;
  const confirm = useSurfaceConfirm();
  const host = useMemo(() => {
    const base = desktopSurfaceHost(
      backendStream('project', projectId),
      journalTail(projectId),
      projectHttp(projectId),
      confirm.confirm,
    );
    return { ...base.host, story: desktopStoryFeed(() => latest.current) };
  }, [projectId, confirm.confirm]);
  return (
    <DesktopStoryContext.Provider value={value}>
      <SurfaceFrame host={host} confirm={confirm} fill>
        <div className="session-story-surface">
          <SessionStoryView />
        </div>
      </SurfaceFrame>
    </DesktopStoryContext.Provider>
  );
}
