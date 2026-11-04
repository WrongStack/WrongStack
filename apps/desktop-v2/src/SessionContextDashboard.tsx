import { ContextDashboard } from '@wrongstack/project-surfaces/context/ContextDashboard';
import type { ContextFeed } from '@wrongstack/project-surfaces/context/context-host';
import { createContext, useContext, useMemo, useRef } from 'react';
import { contextBreakdown, contextSession } from './context-dashboard-model';
import { desktopSurfaceHost } from './desktop-surface-host';
import { projectHttp } from './engine-http';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { backendStream } from './engine-stream';
import { journalTail } from './journal-tail';
import { SessionMemoryInjections } from './SessionMemoryInjections';
import { SurfaceFrame, useSurfaceConfirm } from './SurfaceFrame';
import './session-story.css';

interface DashboardValue {
  state: EngineState;
  projectRoot: string;
  command: EngineCommand;
  onBack: () => void;
}

const DashboardContext = createContext<DashboardValue | null>(null);
const NO_AGENTS: never[] = [];

function useDashboard(): DashboardValue {
  const value = useContext(DashboardContext);
  if (!value) throw new Error('The context dashboard rendered outside its conversation.');
  return value;
}

function DesktopMemoryPanels() {
  const { memoryRuns, memoryContext } = useDashboard().state;
  return <SessionMemoryInjections runs={memoryRuns} context={memoryContext} />;
}

/**
 * The dashboard's feed on one desktop conversation. Hooks read the live state through the
 * context; the breakdown request reads the latest value, so the feed never changes.
 */
function desktopContextFeed(value: () => DashboardValue): ContextFeed {
  return {
    useSessionId: () => useDashboard().state.sessionId || null,
    useSession: () => {
      const { state, projectRoot } = useDashboard();
      return contextSession(state, projectRoot);
    },
    // Workers report no context footprint to the desktop; the section stays hidden.
    useAgents: () => NO_AGENTS,
    useConnectionKey: () => String(useDashboard().state.connected),
    requestDebug: async (signal) => {
      const reply = value().command('context.debug', {}, ['context.debug']);
      const aborted = new Promise<never>((_, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(new Error('The context request was cancelled.')),
          { once: true },
        ),
      );
      return contextBreakdown(await Promise.race([reply, aborted]));
    },
    Memory: DesktopMemoryPanels,
    back: () => value().onBack(),
  };
}

/** The WebUI's context dashboard on one conversation: pressure, make-up, modes and memory. */
export function SessionContextDashboard({
  projectId,
  projectRoot,
  state,
  command,
  onBack,
}: DashboardValue & { projectId: string }) {
  const value = useMemo<DashboardValue>(
    () => ({ state, projectRoot, command, onBack }),
    [state, projectRoot, command, onBack],
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
    return { ...base.host, context: desktopContextFeed(() => latest.current) };
  }, [projectId, confirm.confirm]);
  return (
    <DashboardContext.Provider value={value}>
      <SurfaceFrame host={host} confirm={confirm} fill>
        <div className="session-context-surface">
          <ContextDashboard />
        </div>
      </SurfaceFrame>
    </DashboardContext.Provider>
  );
}
