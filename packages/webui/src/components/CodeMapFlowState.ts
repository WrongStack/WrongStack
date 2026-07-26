import type { Edge, Node } from '@xyflow/react';
import { type CodeMapNodeData, sameCodeMapNodeData } from './CodeMapVisuals';

export function preserveFlowNodes(previous: Node[], next: Node[]): Node[] {
  const previousById = new Map(previous.map((node) => [node.id, node]));
  let changed = previous.length !== next.length;
  const merged = next.map((node, index) => {
    const current = previousById.get(node.id);
    if (!current) {
      changed = true;
      return node;
    }
    const same =
      current.type === node.type &&
      current.position.x === node.position.x &&
      current.position.y === node.position.y &&
      sameCodeMapNodeData(current.data as CodeMapNodeData, node.data as CodeMapNodeData);
    if (same) {
      if (previous[index] !== current) changed = true;
      return current;
    }
    changed = true;
    return { ...current, ...node, measured: current.measured };
  });
  return changed ? merged : previous;
}

function edgeRenderKey(edge: Edge): string | undefined {
  return (edge.data as { renderKey?: string } | undefined)?.renderKey;
}

export function preserveFlowEdges(previous: Edge[], next: Edge[]): Edge[] {
  const previousById = new Map(previous.map((edge) => [edge.id, edge]));
  let changed = previous.length !== next.length;
  const merged = next.map((edge, index) => {
    const current = previousById.get(edge.id);
    if (current && edgeRenderKey(current) === edgeRenderKey(edge)) {
      if (previous[index] !== current) changed = true;
      return current;
    }
    changed = true;
    return edge;
  });
  return changed ? merged : previous;
}
