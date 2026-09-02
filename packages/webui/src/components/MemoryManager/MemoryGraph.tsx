import { useAppTranslation } from '@/i18n';
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Expand } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { SageAnchor, SageEntry, SageGraphEdge } from '@/types';

interface MemoryGraphProps {
  centerMemory: SageEntry;
  allMemories: SageEntry[];
  graphEdges: SageGraphEdge[];
  loading?: boolean;
  error?: string | null;
}

interface MemoryNodeData extends Record<string, unknown> {
  entry: SageEntry;
  center: boolean;
}

interface AnchorNodeData extends Record<string, unknown> {
  anchor: SageAnchor;
  label: string;
}

const NODE_WIDTH = 212;
const ANCHOR_WIDTH = 188;

function compactId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 11)}…` : id;
}

function preview(text: string, max = 58): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function anchorLabel(anchor: SageAnchor): string {
  if (anchor.type === 'symbol') {
    return [anchor.path, anchor.symbol ? `#${anchor.symbol}` : ''].filter(Boolean).join('');
  }
  return anchor.path ?? anchor.command ?? anchor.symbol ?? anchor.role ?? anchor.type;
}

function statusTone(status: string): string {
  if (status === 'active') return 'border-success/45 bg-success/10 text-success';
  if (status === 'stale') return 'border-warning/45 bg-warning/10 text-warning';
  if (status === 'contradicted') return 'border-destructive/45 bg-destructive/10 text-destructive';
  if (status === 'superseded') return 'border-warning/35 bg-warning/5 text-warning';
  return 'border-border bg-muted/55 text-muted-foreground';
}

function MemoryNodeCard({ data }: NodeProps<Node<MemoryNodeData, 'memoryNode'>>) {
  const { entry, center } = data;
  return (
    <div
      className={
        center
          ? 'border border-primary/70 bg-card px-3 py-2.5 text-card-foreground shadow-[0_0_0_1px_hsl(var(--primary)/0.2),0_0_24px_hsl(var(--primary)/0.12)]'
          : 'border border-border/80 bg-card/95 px-3 py-2.5 text-card-foreground shadow-lg'
      }
      style={{ width: NODE_WIDTH }}
      title={entry.text}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!border-background !bg-muted-foreground"
      />
      <Handle type="source" position={Position.Bottom} className="!border-background !bg-primary" />
      <Handle type="source" position={Position.Right} className="!border-background !bg-primary" />
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={`border px-1.5 py-0.5 text-[9px] font-bold uppercase ${statusTone(entry.status)}`}
        >
          {entry.status}
        </span>
        <span className="ml-auto truncate font-mono text-[9px] text-muted-foreground">
          {compactId(entry.id)}
        </span>
      </div>
      <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-foreground/90">
        {preview(entry.text)}
      </p>
      <p className="mt-1 font-mono text-[9px] uppercase text-muted-foreground">{entry.kind}</p>
    </div>
  );
}

function AnchorNodeCard({ data }: NodeProps<Node<AnchorNodeData, 'anchorNode'>>) {
  return (
    <div
      className="border border-info/40 bg-info/8 px-2.5 py-2 text-card-foreground shadow-lg"
      style={{ width: ANCHOR_WIDTH }}
      title={data.label}
    >
      <Handle type="target" position={Position.Left} className="!border-background !bg-info" />
      <p className="font-mono text-[9px] font-bold uppercase text-info">{data.anchor.type}</p>
      <p className="mt-1 truncate font-mono text-[10px] text-foreground/85">{data.label}</p>
    </div>
  );
}

const nodeTypes = {
  memoryNode: MemoryNodeCard,
  anchorNode: AnchorNodeCard,
};

function missingMemory(id: string, t: (key: string) => string): SageEntry {
  return {
    id,
    revision: 0,
    scope: 'project',
    kind: 'fact',
    status: 'deleted',
    text: t('activity:memoryManager.memoryUnavailable'),
    importance: 0,
    confidence: 0,
    freshness: 0,
    tags: [],
    anchors: [],
    createdAt: '',
    updatedAt: '',
  };
}

/** Shared ReactFlow canvas — used inline (small) and in the full-screen modal. */
function GraphCanvas({
  nodes,
  edges,
  className,
}: {
  nodes: Node[];
  edges: Edge[];
  className?: string;
}) {
  return (
    <div className={cn('w-full', className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.24, maxZoom: 1.05 }}
        minZoom={0.4}
        maxZoom={1.5}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnScroll={false}
        zoomOnScroll={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={18}
          size={1}
          color="hsl(var(--muted-foreground) / 0.18)"
        />
        <Controls showInteractive={false} className="!border-border !bg-card !shadow-lg" />
      </ReactFlow>
    </div>
  );
}

export function MemoryGraph({
  centerMemory,
  allMemories,
  graphEdges,
  loading = false,
  error = null,
}: MemoryGraphProps) {
  const { t } = useAppTranslation();
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const centerNode = `mem:${centerMemory.id}`;
  const directMemoryEdges = useMemo(
    () =>
      graphEdges
        .filter(
          (edge) =>
            (edge.from === centerNode && edge.to.startsWith('mem:')) ||
            (edge.to === centerNode && edge.from.startsWith('mem:')),
        )
        .slice(0, 24),
    [centerNode, graphEdges],
  );
  const { nodes, edges } = useMemo(() => {
    const nextNodes: Node[] = [];
    const nextEdges: Edge[] = [];
    const memoryById = new Map(allMemories.map((memory) => [memory.id, memory]));
    const centerX = 320;
    const centerY = 120;

    nextNodes.push({
      id: centerMemory.id,
      type: 'memoryNode',
      position: { x: centerX - NODE_WIDTH / 2, y: centerY },
      data: { entry: centerMemory, center: true },
    });

    const related: Array<{
      id: string;
      relation: string;
      weight?: number;
      evidence?: string[];
    }> = [
      ...(centerMemory.supersededBy
        ? [{ id: centerMemory.supersededBy, relation: 'superseded by' as const }]
        : []),
      ...(centerMemory.supersedes ?? []).map((id) => ({ id, relation: 'supersedes' as const })),
      ...(centerMemory.contradicts ?? []).map((id) => ({ id, relation: 'contradicts' as const })),
    ];
    for (const edge of directMemoryEdges) {
      const otherNode = edge.from === centerNode ? edge.to : edge.from;
      const id = otherNode.slice(4);
      if (related.some((item) => item.id === id && item.relation === edge.relation)) continue;
      related.push({
        id,
        relation: edge.relation,
        weight: edge.weight,
        evidence: edge.evidence,
      });
    }

    const startX = centerX - ((related.length - 1) * 220) / 2;
    related.forEach((item, index) => {
      const entry = memoryById.get(item.id) ?? missingMemory(item.id, t);
      const above = item.relation === 'superseded by';
      const nodeY = above ? 0 : 280 + Math.floor(index / 3) * 130;
      const nodeX = above ? centerX - NODE_WIDTH / 2 : startX + index * 220 - NODE_WIDTH / 2;
      nextNodes.push({
        id: `memory:${item.id}:${index}`,
        type: 'memoryNode',
        position: { x: nodeX, y: nodeY },
        data: { entry, center: false },
      });
      const danger = item.relation === 'contradicts';
      const source = above ? `memory:${item.id}:${index}` : centerMemory.id;
      const target = above ? centerMemory.id : `memory:${item.id}:${index}`;
      nextEdges.push({
        id: `relation:${item.relation}:${item.id}:${index}`,
        source,
        target,
        type: 'smoothstep',
        animated: !danger,
        label:
          item.weight === undefined ? item.relation : `${item.relation} ${item.weight.toFixed(2)}`,
        data: { evidence: item.evidence ?? [] },
        style: {
          stroke: danger ? 'hsl(var(--destructive))' : 'hsl(var(--primary))',
          strokeWidth: 1.7,
          ...(danger ? { strokeDasharray: '5 4' } : {}),
        },
        labelStyle: {
          fill: danger ? 'hsl(var(--destructive))' : 'hsl(var(--muted-foreground))',
          fontSize: 9,
          fontWeight: 700,
        },
        labelBgStyle: { fill: 'hsl(var(--card))', fillOpacity: 0.9 },
      });
    });

    centerMemory.anchors.forEach((anchor, index) => {
      const id = `anchor:${index}`;
      nextNodes.push({
        id,
        type: 'anchorNode',
        position: {
          x: centerX + 220,
          y: centerY + (index - (centerMemory.anchors.length - 1) / 2) * 66,
        },
        data: { anchor, label: anchorLabel(anchor) },
      });
      nextEdges.push({
        id: `anchor-edge:${index}`,
        source: centerMemory.id,
        target: id,
        type: 'smoothstep',
        style: { stroke: 'hsl(var(--info))', strokeWidth: 1.3 },
      });
    });

    return { nodes: nextNodes, edges: nextEdges };
  }, [allMemories, centerMemory, centerNode, directMemoryEdges]);

  if (nodes.length <= 1 && !loading && !error) return null;

  return (
    <section
      className="overflow-hidden border border-border/75 bg-background/35"
      aria-label={t('activity:memoryManager.graphAria')}
    >
      <div className="flex items-center justify-between border-b border-border/70 bg-card/55 px-3 py-2">
        <div className="flex items-center gap-2">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            {t('activity:memoryManager.graphHeading')}
          </p>
          {nodes.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFullscreenOpen(true)}
              className="h-6 gap-1 px-2 text-[9px] font-bold uppercase tracking-[0.12em]"
              aria-label={t('activity:memoryManager.graphFullscreenAria')}
            >
              <Expand className="size-3" />
              {t('activity:memoryManager.graphOpenFullscreen')}
            </Button>
          )}
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">
          {loading
            ? t('activity:memoryManager.loadingGraph')
            : t('activity:memoryManager.graphStats', { nodes: nodes.length, edges: edges.length })}
        </span>
      </div>
      {error && (
        <p className="border-b border-destructive/25 bg-destructive/5 px-3 py-2 text-[10px] text-destructive">
          {error}
        </p>
      )}
      {nodes.length > 1 && <GraphCanvas nodes={nodes} edges={edges} className="h-[320px]" />}
      {directMemoryEdges.some((edge) => edge.evidence?.length) && (
        <div className="grid gap-1 border-t border-border/70 bg-card/35 px-3 py-2">
          {directMemoryEdges
            .filter((edge) => edge.evidence?.length)
            .slice(0, 12)
            .map((edge) => {
              const other = (edge.from === centerNode ? edge.to : edge.from).slice(4);
              return (
                <p key={edge.id} className="truncate font-mono text-[9px] text-muted-foreground">
                  <span className="text-info">{edge.relation}</span> {compactId(other)} · why:{' '}
                  {edge.evidence?.join(', ')}
                </p>
              );
            })}
        </div>
      )}

      {fullscreenOpen && (
        <Dialog open={fullscreenOpen} onOpenChange={setFullscreenOpen}>
          <DialogContent
            className="flex max-h-[90dvh] max-w-[90vw] flex-col p-0"
            showCloseButton={false}
          >
            <div className="flex items-center justify-between border-b border-border/70 bg-card/55 px-4 py-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                {t('activity:memoryManager.graphHeadingFull', { id: centerMemory.id })}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFullscreenOpen(false)}
                className="h-7 gap-1 px-2 text-[10px]"
              >
                {t('common:action.close')}
              </Button>
            </div>
            <div className="min-h-0 flex-1 px-4 pb-4">
              <GraphCanvas nodes={nodes} edges={edges} className="h-[65vh]" />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
