import { Radio, X } from 'lucide-react';
import type { FileActivity } from '@/stores/codemap-activity-store';
import { CodeMapActivityStreamPanel } from './CodeMapActivityStreamPanel';
import { CodeMapSelectedNodeSummary } from './CodeMapSelectedNodeSummary';
import { LiveOperationRow } from './CodeMapLiveOverlay';
import { RelationSection } from './CodeMapRelations';
import type { CodeMapGraphResponse, GraphNodeData, RelationItem } from './codemap-model';
import { useAppTranslation } from '@/i18n';

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
}: CodeMapRelationInspectorProps): React.ReactElement {
  const { t } = useAppTranslation();
  return (
    <aside className="flex w-[326px] shrink-0 flex-col border-l bg-card/80">
      <div className="flex h-10 items-center justify-between border-b px-3">
        <h2 className="text-[10px] font-bold uppercase tracking-[0.18em]">
          {t('activity:codeMap.relationInspector')}
        </h2>
        {selectedNode && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={onClearSelection}
            aria-label={t('activity:codeMap.clearSelection')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
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
        </div>
      )}
    </aside>
  );
}
