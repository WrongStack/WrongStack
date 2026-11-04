import type {
  AtlasContext,
  AtlasHost,
  AtlasView,
  CodeAssistTarget,
} from '@wrongstack/project-surfaces/atlas/atlas-host';
import { useCodemapIndexStore } from '@wrongstack/project-surfaces/atlas/codemap-index-store';
import type { GraphNodeData } from '@wrongstack/project-surfaces/atlas/codemap-model';
import { Boxes, Crosshair, Grid2X2, LoaderCircle, RefreshCw } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AtlasNodeEvidence } from './AtlasDetails';
import { AtlasImpactView, AtlasMatrixView, AtlasSubsystemView } from './AtlasViews';
import { DesktopCodeAssist } from './DesktopCodeAssist';
import { useDesktopText } from './desktop-i18n';
import type { EngineHttp } from './engine-http';
import type { EngineCommand, EngineSend } from './engine-operations';
import type { EngineState } from './engine-state';
import { record } from './engine-values';
import { atlasGraph } from './graph-model';
import { projectPath } from './project-path';
import { surfaceI18n } from './surface-i18n';
import './atlas-views.css';

/** What the desktop's atlas panels read: the project's engine and its live state. */
export interface DesktopAtlasValue {
  projectRoot: string;
  http: EngineHttp;
  send: EngineSend;
  command: EngineCommand;
  state: EngineState;
  onOpenFile?: ((path: string) => void) | undefined;
  onOpenMemory?: ((id: string) => void) | undefined;
}

export const DesktopAtlasContext = createContext<DesktopAtlasValue | null>(null);

function useDesktopAtlas(): DesktopAtlasValue {
  const value = useContext(DesktopAtlasContext);
  if (!value) throw new Error('A desktop atlas panel rendered outside its project.');
  return value;
}

/** Asks an agent about the selected code; editing runs offer their before/after review. */
function AtlasCodeAssist({
  target,
  className,
}: {
  target: CodeAssistTarget | null;
  className?: string | undefined;
}) {
  const { send, command, state } = useDesktopAtlas();
  if (!target) return null;
  return (
    <div className={`atlas-code-assist ${className ?? ''}`}>
      <DesktopCodeAssist
        key={`${target.filePath}:${target.symbol ?? ''}`}
        filePath={target.filePath}
        {...(target.symbol ? { symbol: target.symbol } : {})}
        {...(target.line !== undefined ? { line: target.line } : {})}
        send={send}
        command={command}
        state={state}
        onEdited={() => useCodemapIndexStore.getState().notifyIndexUpdated()}
      />
    </div>
  );
}

const STATUS_POLL_MS = 1200;

/** Builds the project's code index on request and reports a running or failed build. */
function AtlasIndexControls() {
  const { http } = useDesktopAtlas();
  const { t } = useDesktopText();
  const [indexing, setIndexing] = useState(false);
  const [error, setError] = useState('');
  const building = useRef(false);
  const posting = useRef(false);
  const expectedJob = useRef<number | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = record(await http('/api/codemap/status'));
        if (stopped) return;
        const waiting =
          posting.current ||
          (expectedJob.current !== null && result['startedAt'] !== expectedJob.current);
        if (!waiting) {
          if (result['status'] === 'indexing') {
            building.current = true;
            setIndexing(true);
          } else if (result['status'] === 'error') {
            building.current = false;
            setIndexing(false);
            setError(String(result['error'] ?? t('atlasHost.indexFailed')));
          } else if (result['status'] === 'ready') {
            setIndexing(false);
            // The map reloads in place when a build it waited for finishes.
            if (building.current) {
              building.current = false;
              useCodemapIndexStore.getState().notifyIndexUpdated();
            }
          }
        }
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
      }
      if (!stopped) timer = setTimeout(poll, STATUS_POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [http]);
  const index = async () => {
    setError('');
    setIndexing(true);
    posting.current = true;
    try {
      const result = record(await http('/api/codemap/index', 'POST', {}));
      expectedJob.current = typeof result['startedAt'] === 'number' ? result['startedAt'] : null;
      building.current = true;
    } catch (cause) {
      setIndexing(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      posting.current = false;
    }
  };
  return (
    <div className="atlas-index-controls">
      {error && (
        <span className="atlas-index-error" role="alert" title={error}>
          {error}
        </span>
      )}
      <button
        type="button"
        className="button secondary"
        disabled={indexing}
        onClick={() => void index()}
      >
        {indexing ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
        {indexing ? t('atlasHost.mapping') : t('atlasHost.index')}
      </button>
    </div>
  );
}

type AnalysisKind = 'subsystems' | 'matrix' | 'impact';

/** The desktop's analysis views over the scope the map shows. */
function AtlasAnalysis({ kind, context }: { kind: AnalysisKind; context: AtlasContext }) {
  const graph = useMemo(() => atlasGraph(context.graph), [context.graph]);
  const props = {
    graph,
    selected: context.selectedId ?? '',
    onSelect: context.select,
    onOpen: context.open,
  };
  return (
    <div className="atlas-analysis-surface">
      {kind === 'subsystems' ? (
        <AtlasSubsystemView {...props} />
      ) : kind === 'matrix' ? (
        <AtlasMatrixView {...props} />
      ) : (
        <AtlasImpactView {...props} />
      )}
    </div>
  );
}

/** Read when the shared atlas renders, so the tab labels follow the display language. */
const desktopWord = (key: string) => surfaceI18n.t(key, { ns: 'desktop' });

const ANALYSIS_VIEWS: readonly AtlasView[] = [
  {
    id: 'subsystems',
    get label() {
      return desktopWord('atlasHost.subsystems');
    },
    get hint() {
      return desktopWord('atlasHost.subsystemsHint');
    },
    Icon: Boxes,
    render: (context) => <AtlasAnalysis kind="subsystems" context={context} />,
  },
  {
    id: 'matrix',
    get label() {
      return desktopWord('atlasHost.matrix');
    },
    get hint() {
      return desktopWord('atlasHost.matrixHint');
    },
    Icon: Grid2X2,
    render: (context) => <AtlasAnalysis kind="matrix" context={context} />,
  },
  {
    id: 'impact',
    get label() {
      return desktopWord('atlasHost.impact');
    },
    get hint() {
      return desktopWord('atlasHost.impactHint');
    },
    Icon: Crosshair,
    render: (context) => <AtlasAnalysis kind="impact" context={context} />,
  },
];

/** The selected node's WrongTrace signals, SAGE knowledge and file history. */
function AtlasEvidence({ node }: { node: GraphNodeData; context: AtlasContext }) {
  const { command, projectRoot, onOpenFile, onOpenMemory } = useDesktopAtlas();
  const visual = useMemo(() => atlasGraph({ nodes: [node], edges: [] }).nodes[0], [node]);
  if (!visual) return null;
  return (
    <section className="atlas-evidence">
      <AtlasNodeEvidence
        node={visual}
        command={command}
        {...(onOpenMemory ? { onOpenMemory } : {})}
        {...(onOpenFile
          ? { onOpenFile: (file: string) => onOpenFile(projectPath(file, projectRoot)) }
          : {})}
      />
    </section>
  );
}

/** The desktop's additions to the shared Code Atlas. */
export const DESKTOP_ATLAS: AtlasHost = {
  CodeAssist: AtlasCodeAssist,
  HeaderActions: AtlasIndexControls,
  views: ANALYSIS_VIEWS,
  NodeExtras: AtlasEvidence,
};
