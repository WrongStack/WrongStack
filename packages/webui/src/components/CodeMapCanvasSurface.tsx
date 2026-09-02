import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  ReactFlow,
  type OnEdgesChange,
  type OnNodesChange,
} from '@xyflow/react';
import { Loader2, Network } from 'lucide-react';
import type React from 'react';
import { type CodeMapNodeData, EDGE_COLOR, nodeTypes } from './CodeMapVisuals';
import { MINIMAP_NODE_LIMIT } from './CodeMapConfig';
import type { CodeMapGraphResponse, GraphRefType } from './codemap-model';
import { useAppTranslation } from '@/i18n';

/** A 401/403 surfaced by the fetch — an auth problem, not a missing index. */
function isAuthError(message: string): boolean {
  return /Authentication required|Unauthorized/i.test(message);
}

export function CodeMapCanvasSurface({
  loading,
  error,
  graph,
  canvasNodeCount,
  flowNodes,
  flowEdges,
  onNodesChange,
  onEdgesChange,
  agentTrailCount,
}: {
  loading: boolean;
  error: string | null;
  graph: CodeMapGraphResponse;
  canvasNodeCount: number;
  flowNodes: Node[];
  flowEdges: Edge[];
  onNodesChange: OnNodesChange<Node>;
  onEdgesChange: OnEdgesChange<Edge>;
  agentTrailCount: number;
}): React.ReactElement {
  const { t } = useAppTranslation();
  return (
    <>
      {loading && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/75 backdrop-blur-sm">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {t('activity:codeMap.mappingRelationships')}
          </span>
        </div>
      )}
      {error && !loading && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 p-8 text-center">
          <Network className="h-10 w-10 text-destructive" />
          <p className="font-mono text-sm text-destructive">{error}</p>
          {!isAuthError(error) && (
            <p className="max-w-md text-xs text-muted-foreground">
              The map needs a codebase index. Run{' '}
              <code className="border bg-muted px-1.5 py-0.5">codebase-index</code>{' '}
              {t('activity:codeMap.onceThenReopenThisView')}
            </p>
          )}
        </div>
      )}
      {!loading && !error && graph.nodes.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
          <Network className="h-8 w-8 opacity-40" />
          <p className="text-xs">{t('activity:codeMap.noIndexedNodesAtThisLevel')}</p>
        </div>
      )}
      {!loading && !error && graph.nodes.length > 1 && graph.edges.length === 0 && (
        <div className="pointer-events-none absolute left-1/2 top-14 z-10 -translate-x-1/2 border border-warning/40 bg-warning/10 px-3 py-2 text-center shadow backdrop-blur">
          <div className="font-mono text-[9px] font-bold uppercase tracking-wider text-warning">
            {t('activity:codeMap.noResolvedRelationsInThisScope')}
          </div>
          <div className="mt-0.5 text-[8px] text-muted-foreground">
            {t('activity:codeMap.theUpgradedIndexWillRebuildAnd')}
          </div>
        </div>
      )}
      {!error && graph.nodes.length > 0 && (
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          nodesConnectable={false}
          nodesDraggable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          onlyRenderVisibleElements
          minZoom={0.08}
          maxZoom={2.2}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={canvasNodeCount > 60 ? 32 : 22}
            size={1}
            color="hsl(var(--muted-foreground))"
            className="!opacity-25"
          />
          <Controls
            position="bottom-left"
            showInteractive={false}
            className="!border !border-border !bg-card !shadow-md [&>button]:!border-border [&>button]:!bg-card [&>button]:!fill-foreground"
          />
          {canvasNodeCount <= MINIMAP_NODE_LIMIT && (
            <MiniMap
              position="bottom-right"
              pannable
              zoomable
              className="!h-[112px] !w-[180px] !border !border-border !bg-card !shadow-md"
              maskColor="hsl(var(--background) / 0.72)"
              nodeColor={(node) => {
                const kind = (node.data as CodeMapNodeData | undefined)?.graphNode.kind;
                return kind === 'package'
                  ? 'hsl(var(--primary))'
                  : kind === 'file'
                    ? 'hsl(var(--info))'
                    : 'hsl(var(--success))';
              }}
            />
          )}
        </ReactFlow>
      )}
      <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 border bg-card/90 px-3 py-1.5 font-mono text-[8px] text-muted-foreground shadow backdrop-blur">
        {(Object.entries(EDGE_COLOR) as [GraphRefType, string][]).map(([kind, color]) => (
          <span key={kind} className="flex items-center gap-1">
            <span className="h-0.5 w-3" style={{ backgroundColor: color }} />
            {kind.replace('_', ' ')}
          </span>
        ))}
        <span className="flex items-center gap-1 text-primary" data-testid="agent-trail-count">
          <span className="w-4 border-t-2 border-dashed border-primary" />
          agent trail{agentTrailCount > 0 ? ` ×${agentTrailCount}` : ''}
        </span>
      </div>
    </>
  );
}
