import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import {
  evaluateContractGraph,
  evaluateContractGraphReadiness,
} from '@wrongstack/kanban/contract-graph';
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertTriangle, CheckCircle2, Maximize2, Network, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { buildContractGraphView } from './KanbanContractGraphView';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

function ContractTaskCanvas({
  graph,
  expanded,
}: {
  graph: ReturnType<typeof buildContractGraphView>;
  expanded: boolean;
}) {
  return (
    <div
      data-contract-canvas={expanded ? 'expanded' : 'embedded'}
      className={
        expanded
          ? 'h-full min-h-0 w-full bg-background'
          : 'h-[32rem] min-h-[32rem] w-full bg-background'
      }
    >
      <ReactFlow
        nodes={graph.nodes}
        edges={graph.edges}
        fitView
        fitViewOptions={{ padding: expanded ? 0.12 : 0.2, maxZoom: expanded ? 1.15 : 0.9 }}
        minZoom={0.12}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        panOnDrag
        zoomOnScroll={expanded}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.2}
          color="hsl(var(--border))"
        />
        <Controls
          showInteractive={false}
          className="!overflow-hidden !rounded-lg !border !border-border !bg-background !shadow-xl [&_button]:!border-border [&_button]:!bg-muted [&_button]:!fill-foreground"
        />
        {expanded && (
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) => String(node.data.color ?? 'hsl(var(--muted-foreground))')}
            maskColor="hsl(var(--background) / 0.72)"
            className="!border !border-border !bg-background"
          />
        )}
      </ReactFlow>
    </div>
  );
}

export function KanbanContractGraphPanel({
  board,
  task,
  sendKanban,
}: {
  board: KanbanBoard;
  task: KanbanTask;
  /**
   * Optional so the panel still renders read-only where no sender is wired.
   * Without it the empty state below is a statement; with it, it is an action.
   */
  sendKanban?: ((type: `kanban.${string}`, payload?: Record<string, unknown>) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const evaluation = useMemo(() => evaluateContractGraph(board, task.id), [board, task.id]);
  const readiness = useMemo(() => evaluateContractGraphReadiness(board, task.id), [board, task.id]);
  const graph = useMemo(
    () => buildContractGraphView(board, task, evaluation.evaluatedNodeIds),
    [board, task, evaluation.evaluatedNodeIds],
  );

  if (!board.contractGraph) {
    return (
      <section className="mt-4 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-2 font-medium">
          <Network size={14} /> Contract graph not configured
        </div>
        <p className="mt-1">
          Objectives, affected components, guardrails, risks, and verification evidence are not yet
          mapped for this board.
        </p>
        {sendKanban && (
          <button
            type="button"
            onClick={() =>
              sendKanban('kanban.contract.configure', {
                boardId: board.id,
                enforcement: 'advisory',
              })
            }
            className="mt-2 rounded-md bg-primary/10 px-2.5 py-1.5 font-medium text-primary hover:bg-primary/20"
          >
            Start contract map
          </button>
        )}
      </section>
    );
  }

  const closed = evaluation.allowed && evaluation.issues.length === 0;
  return (
    <section className="mt-4 overflow-hidden rounded-md border bg-background">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <Network size={14} /> Contract graph
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {board.contractGraph.enforcement}
          </span>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2 text-[11px]">
          <span className={readiness.ready ? 'text-primary' : 'text-warning'}>
            {readiness.ready ? 'Start ready' : `${readiness.issues.length} setup gaps`}
          </span>
          <span
            className={`inline-flex items-center gap-1 ${closed ? 'text-success' : 'text-warning'}`}
          >
            {closed ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
            {closed ? 'Closed' : `${evaluation.issues.length} completion open`}
          </span>
          {graph.nodes.length > 1 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/25 bg-primary/10 px-2 py-1 font-semibold text-primary transition-colors hover:bg-primary/20"
              aria-label="Expand Contract Map"
            >
              <Maximize2 size={12} /> Expand
            </button>
          )}
        </div>
      </header>

      {graph.nodes.length > 1 ? (
        <ContractTaskCanvas graph={graph} expanded={false} />
      ) : (
        <div className="p-3 text-xs text-muted-foreground">
          No contract nodes belong to this task.
        </div>
      )}

      {evaluation.issues.length > 0 && (
        <div className="space-y-1 border-t px-3 py-2">
          {evaluation.issues.map((issue, index) => (
            <div
              key={`${issue.code}:${issue.nodeId ?? issue.edgeId ?? index}`}
              className="flex items-start gap-1.5 text-[11px] text-warning"
            >
              <ShieldCheck className="mt-0.5 shrink-0" size={12} />
              <span>{issue.message}</span>
            </div>
          ))}
        </div>
      )}
      {readiness.issues.length > 0 && (
        <div className="space-y-1 border-t px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Before implementation
          </div>
          {readiness.issues.map((issue, index) => (
            <div
              key={`readiness:${issue.code}:${issue.nodeId ?? index}`}
              className="flex items-start gap-1.5 text-[11px] text-warning"
            >
              <AlertTriangle className="mt-0.5 shrink-0" size={12} />
              <span>{issue.message}</span>
            </div>
          ))}
        </div>
      )}

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          aria-describedby="contract-map-modal-description"
          className="flex h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden border-border bg-background p-0 text-foreground sm:p-0"
        >
          <div className="shrink-0 border-b border-border bg-background/90 px-5 py-4 pr-14 text-foreground">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Network size={17} className="text-primary" /> Contract Map · {task.title}
            </DialogTitle>
            <DialogDescription
              id="contract-map-modal-description"
              className="mt-1 text-xs text-muted-foreground"
            >
              Full dependency field · drag to pan, scroll or controls to zoom, Escape to close.
            </DialogDescription>
          </div>
          <div className="min-h-0 flex-1">
            <ContractTaskCanvas graph={graph} expanded />
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
