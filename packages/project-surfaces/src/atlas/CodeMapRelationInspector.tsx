import { ArrowRight, ChevronLeft, ChevronRight, Compass, Radio, Route, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAppTranslation } from '../lib/i18n';
import { CodeMapActivityStreamPanel } from './CodeMapActivityStreamPanel';
import { LiveOperationRow } from './CodeMapLiveOverlay';
import { RelationSection } from './CodeMapRelations';
import { CodeMapSelectedNodeSummary } from './CodeMapSelectedNodeSummary';
import type { FileActivity } from './codemap-activity-store';
import {
  buildCanvasGuidedTour,
  type CanvasTourPersona,
  type CodeMapGraphResponse,
  type CodeMapLayout,
  findShortestPathBetweenNodes,
  type GraphNodeData,
  listGraphClusters,
  type RelationItem,
  type ShortestPathResult,
  sliceCanvasExecutionFlow,
} from './codemap-model';

interface CodeMapRelationInspectorProps {
  selectedNode: GraphNodeData | undefined;
  incoming: RelationItem[];
  outgoing: RelationItem[];
  filteredGraph: CodeMapGraphResponse;
  expandedRelations: Set<string>;
  activeOperations: FileActivity[];
  recentActivities: FileActivity[];
  activityTotalCount: number;
  selectedActivities: FileActivity[];
  onClearSelection: () => void;
  onOpenNode: (node: GraphNodeData) => void;
  onOpenActivity: (filePath: string) => void;
  onLocateActivity: (activity: FileActivity) => void;
  onToggleRelation: (key: string) => void;
  onSelectNode: (node: GraphNodeData) => void;
  onFocusNode?: ((node: GraphNodeData) => void) | undefined;
  onHighlightPath?: ((path: ShortestPathResult | null) => void) | undefined;
  layout?: CodeMapLayout | undefined;
  collapsedClusters?: ReadonlySet<string> | undefined;
  onToggleCluster?: ((clusterName: string) => void) | undefined;
  /**
   * Pinned to the bottom of the aside, above nothing and below the scrolling
   * relation list. Used by the "Ask AI" panel so it shares this 326px column
   * instead of adding a third one beside the tree and this inspector.
   */
  footer?: React.ReactNode;
  /** The application's own evidence about the selected node, above its relations. */
  extras?: React.ReactNode;
}

export function CodeMapRelationInspector({
  selectedNode,
  incoming,
  outgoing,
  filteredGraph,
  expandedRelations,
  activeOperations,
  recentActivities,
  activityTotalCount,
  selectedActivities,
  onClearSelection,
  onOpenNode,
  onOpenActivity,
  onLocateActivity,
  onToggleRelation,
  onSelectNode,
  onFocusNode,
  onHighlightPath,
  layout,
  collapsedClusters,
  onToggleCluster,
  footer,
  extras,
}: CodeMapRelationInspectorProps): React.ReactElement {
  const { t } = useAppTranslation();
  const [pathTargetId, setPathTargetId] = useState<string>('');
  const [tourIndex, setTourIndex] = useState<number | null>(null);
  const [tourPersona, setTourPersona] = useState<CanvasTourPersona>('experienced');
  const [traceFlowActive, setTraceFlowActive] = useState<boolean>(false);

  const tourSteps = useMemo(
    () => buildCanvasGuidedTour(filteredGraph, 8, tourPersona),
    [filteredGraph, tourPersona],
  );
  const clusters = useMemo(
    () =>
      layout === 'subsystems' ? listGraphClusters(filteredGraph).filter((c) => c.count >= 2) : [],
    [filteredGraph, layout],
  );
  const activeTourStep =
    tourIndex !== null && tourSteps[tourIndex] ? tourSteps[tourIndex] : undefined;

  const stepTour = (nextIdx: number): void => {
    const clamped = Math.max(0, Math.min(nextIdx, tourSteps.length - 1));
    setTourIndex(clamped);
    const step = tourSteps[clamped];
    if (step) {
      onSelectNode(step.node);
      onFocusNode?.(step.node);
    }
  };

  const otherNodes = useMemo(
    () =>
      selectedNode
        ? filteredGraph.nodes
            .filter((n) => n.id !== selectedNode.id)
            .sort((a, b) => a.label.localeCompare(b.label))
        : [],
    [filteredGraph.nodes, selectedNode],
  );

  const shortestPath = useMemo(() => {
    if (!selectedNode) return null;
    if (traceFlowActive) {
      return sliceCanvasExecutionFlow(filteredGraph, selectedNode.id, 6);
    }
    if (!pathTargetId) return null;
    return findShortestPathBetweenNodes(filteredGraph, selectedNode.id, pathTargetId);
  }, [filteredGraph, selectedNode, pathTargetId, traceFlowActive]);

  useEffect(() => {
    onHighlightPath?.(shortestPath);
  }, [onHighlightPath, shortestPath]);

  return (
    <aside className="ws-code-inspector flex w-[326px] shrink-0 flex-col border-l bg-card/80">
      <div className="flex h-10 items-center justify-between border-b px-3">
        <h2 className="text-[10px] font-bold uppercase tracking-[0.18em]">
          {t('activity:codeMap.relationInspector')}
        </h2>
        <div className="flex items-center gap-2">
          {tourSteps.length > 1 && (
            <button
              type="button"
              onClick={() => (tourIndex === null ? stepTour(0) : setTourIndex(null))}
              className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              title={t('activity:codeMap.guidedArchitectureTour')}
            >
              <Compass className="h-3 w-3" />
              {tourIndex === null ? 'Tour' : `${tourIndex + 1}/${tourSteps.length}`}
            </button>
          )}
          {selectedNode && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                setTourIndex(null);
                onClearSelection();
              }}
              aria-label={t('activity:codeMap.clearSelection')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      {activeTourStep && (
        <div className="border-b bg-muted/30 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] font-semibold uppercase text-primary">
              {t('activity:codeMapText.tourStep', {
                step: activeTourStep.order,
                total: tourSteps.length,
                stage: activeTourStep.stage,
              })}
            </span>
            <div className="flex items-center gap-1">
              <select
                value={tourPersona}
                onChange={(e) => setTourPersona(e.target.value as CanvasTourPersona)}
                aria-label={t('activity:codeMapText.tourPersona')}
                className="min-h-0 rounded border bg-background px-1 py-0.5 text-[9px] text-muted-foreground shadow-none"
              >
                <option value="experienced">{t('activity:codeMapText.persona.experienced')}</option>
                <option value="junior">{t('activity:codeMapText.persona.junior')}</option>
                <option value="non-technical">
                  {t('activity:codeMapText.persona.nonTechnical')}
                </option>
              </select>
              <button
                type="button"
                disabled={tourIndex === 0}
                onClick={() => stepTour((tourIndex ?? 1) - 1)}
                className="rounded border p-0.5 hover:bg-muted disabled:opacity-40"
                aria-label={t('activity:codeMap.previousTourStep')}
              >
                <ChevronLeft className="h-3 w-3" />
              </button>
              <button
                type="button"
                disabled={tourIndex === tourSteps.length - 1}
                onClick={() => stepTour((tourIndex ?? 0) + 1)}
                className="rounded border p-0.5 hover:bg-muted disabled:opacity-40"
                aria-label={t('activity:codeMap.nextTourStep')}
              >
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">{activeTourStep.explanation}</p>
        </div>
      )}
      {clusters.length > 0 && onToggleCluster && (
        <div className="border-b bg-muted/20 px-3 py-2">
          <div className="mb-1.5 text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            {t('activity:codeMapText.clusters', { count: clusters.length })}
          </div>
          <div className="flex flex-wrap gap-1">
            {clusters.map((c) => {
              const isCollapsed = collapsedClusters?.has(c.name) ?? false;
              return (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => onToggleCluster(c.name)}
                  className="inline-flex items-center gap-1 rounded border bg-background px-1.5 py-0.5 font-mono text-[10px] hover:bg-muted"
                  title={
                    isCollapsed
                      ? t('activity:codeMapText.expandCluster')
                      : t('activity:codeMapText.collapseCluster')
                  }
                >
                  <span>{isCollapsed ? '▸' : '▾'}</span>
                  <span className="max-w-[140px] truncate">{c.name}</span>
                  <span className="text-muted-foreground">({c.count})</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {!selectedNode ? (
        <CodeMapActivityStreamPanel
          activeOperations={activeOperations}
          recentActivities={recentActivities}
          activityTotalCount={activityTotalCount}
          onLocate={onLocateActivity}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <CodeMapSelectedNodeSummary
            node={selectedNode}
            incomingCount={incoming.length}
            outgoingCount={outgoing.length}
            onOpenNode={onOpenNode}
            onOpenActivity={onOpenActivity}
          />
          {selectedActivities.length > 0 && (
            <section className="border-b bg-success/5 py-2">
              <div className="mb-1 flex items-center gap-2 px-3">
                <Radio className="h-3 w-3 animate-pulse text-success" />
                <h3 className="text-[9px] font-bold uppercase tracking-[0.16em]">
                  {t('activity:codeMap.agentsOnThisNode')}
                </h3>
                <span className="ml-auto font-mono text-[9px] text-success">
                  {selectedActivities.length}
                </span>
              </div>
              {selectedActivities.map((activity) => (
                <LiveOperationRow
                  key={activity.id ?? `${activity.toolUseId}:${activity.filePath}`}
                  activity={activity}
                  onLocate={onLocateActivity}
                  showAgent
                />
              ))}
            </section>
          )}
          {extras}
          <RelationSection
            title={t('activity:codeMap.incoming')}
            subtitle={t('activity:codeMap.whoDependsOnThis')}
            items={incoming}
            graph={filteredGraph}
            selectedId={selectedNode.id}
            expanded={expandedRelations}
            onToggle={onToggleRelation}
            onSelect={onSelectNode}
          />
          <RelationSection
            title={t('activity:codeMap.outgoing')}
            subtitle={t('activity:codeMap.whatThisDependsOn')}
            items={outgoing}
            graph={filteredGraph}
            selectedId={selectedNode.id}
            expanded={expandedRelations}
            onToggle={onToggleRelation}
            onSelect={onSelectNode}
          />
          {otherNodes.length > 0 && (
            <section className="border-t px-3 py-2.5">
              <div className="mb-1.5 flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5">
                  <Route className="h-3 w-3 text-muted-foreground" />
                  <h3 className="text-[9px] font-bold uppercase tracking-[0.16em]">
                    {t('activity:codeMapText.pathFinder')}
                  </h3>
                </div>
                {outgoing.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setTraceFlowActive((v) => !v);
                      setPathTargetId('');
                    }}
                    className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${
                      traceFlowActive
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    {traceFlowActive
                      ? t('activity:codeMapText.flowActive')
                      : t('activity:codeMapText.traceFlow')}
                  </button>
                )}
              </div>
              <select
                value={pathTargetId}
                onChange={(e) => {
                  setTraceFlowActive(false);
                  setPathTargetId(e.target.value);
                }}
                aria-label={t('activity:codeMap.traceShortestPathToTargetNode')}
                className="w-full rounded border bg-background px-2 py-1 font-mono text-[11px] text-foreground"
              >
                <option value="">{t('activity:codeMap.selectTargetNode')}</option>
                {otherNodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.label}
                  </option>
                ))}
              </select>
              {(pathTargetId || traceFlowActive) && (
                <div className="mt-2">
                  {shortestPath ? (
                    <div className="flex flex-wrap items-center gap-1 text-[11px]">
                      {shortestPath.nodes.map((hop, idx) => (
                        <span key={hop.id} className="inline-flex items-center gap-1">
                          {idx > 0 && <ArrowRight className="h-2.5 w-2.5 text-muted-foreground" />}
                          <button
                            type="button"
                            onClick={() => {
                              onSelectNode(hop);
                              onFocusNode?.(hop);
                            }}
                            className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] hover:bg-muted"
                          >
                            {hop.label}
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      {t('activity:codeMapText.noPath')}
                    </p>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      )}
      {footer}
    </aside>
  );
}
