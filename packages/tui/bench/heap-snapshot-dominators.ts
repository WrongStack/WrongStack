import { readFile } from 'node:fs/promises';

interface HeapSnapshotMeta {
  node_fields: string[];
  node_types: Array<string[] | string>;
  edge_fields: string[];
  edge_types: Array<string[] | string>;
}

interface HeapSnapshotFile {
  snapshot: {
    meta: HeapSnapshotMeta;
    node_count: number;
    edge_count: number;
  };
  nodes: number[];
  edges: number[];
  strings: string[];
}

interface HeapDominator {
  rank: number;
  nodeIndex: number;
  type: string;
  name: string;
  id: number;
  selfSize: number;
  retainedSize: number;
  dominatedNodes: number;
}

interface HeapDominatorReport {
  snapshotPath: string;
  nodeCount: number;
  edgeCount: number;
  reachableNodeCount: number;
  reachableSelfSize: number;
  ignoredWeakEdges: number;
  dominators: HeapDominator[];
}

function fieldIndex(fields: readonly string[], name: string): number {
  const index = fields.indexOf(name);
  if (index < 0) throw new Error(`Heap snapshot is missing ${name}`);
  return index;
}

function stringTypes(value: string[] | string | undefined, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Heap snapshot ${label} metadata is invalid`);
  return value;
}

function assertSnapshot(value: unknown): asserts value is HeapSnapshotFile {
  if (!value || typeof value !== 'object') throw new Error('Heap snapshot root must be an object');
  const candidate = value as Partial<HeapSnapshotFile>;
  if (!candidate.snapshot?.meta || !Array.isArray(candidate.nodes)) {
    throw new Error('Heap snapshot is missing node metadata');
  }
  if (!Array.isArray(candidate.edges) || !Array.isArray(candidate.strings)) {
    throw new Error('Heap snapshot is missing edges or strings');
  }
}

/**
 * Compute exact immediate dominators with the Lengauer-Tarjan algorithm.
 * Weak V8 edges are excluded because they do not keep their targets alive.
 */
export function analyzeHeapSnapshot(
  snapshot: unknown,
  snapshotPath = '<memory>',
  limit = 25,
): HeapDominatorReport {
  assertSnapshot(snapshot);
  const { meta, node_count: nodeCount, edge_count: edgeCount } = snapshot.snapshot;
  const nodeFields = meta.node_fields;
  const edgeFields = meta.edge_fields;
  const nodeFieldCount = nodeFields.length;
  const edgeFieldCount = edgeFields.length;
  const nodeTypeIndex = fieldIndex(nodeFields, 'type');
  const nodeNameIndex = fieldIndex(nodeFields, 'name');
  const nodeIdIndex = fieldIndex(nodeFields, 'id');
  const nodeSelfSizeIndex = fieldIndex(nodeFields, 'self_size');
  const nodeEdgeCountIndex = fieldIndex(nodeFields, 'edge_count');
  const edgeTypeIndex = fieldIndex(edgeFields, 'type');
  const edgeTargetIndex = fieldIndex(edgeFields, 'to_node');
  const nodeTypes = stringTypes(meta.node_types[nodeTypeIndex], 'node type');
  const edgeTypes = stringTypes(meta.edge_types[edgeTypeIndex], 'edge type');
  const weakEdgeType = edgeTypes.indexOf('weak');

  if (snapshot.nodes.length !== nodeCount * nodeFieldCount) {
    throw new Error('Heap snapshot node array length does not match node_count');
  }
  if (snapshot.edges.length !== edgeCount * edgeFieldCount) {
    throw new Error('Heap snapshot edge array length does not match edge_count');
  }

  const edgeStarts = new Uint32Array(nodeCount + 1);
  let edgeOffset = 0;
  for (let ordinal = 0; ordinal < nodeCount; ordinal++) {
    edgeStarts[ordinal] = edgeOffset;
    const nodeOffset = ordinal * nodeFieldCount;
    edgeOffset += snapshot.nodes[nodeOffset + nodeEdgeCountIndex]! * edgeFieldCount;
  }
  edgeStarts[nodeCount] = edgeOffset;

  const dfsByOrdinal = new Uint32Array(nodeCount);
  const vertex = new Uint32Array(nodeCount + 1);
  const parent = new Uint32Array(nodeCount + 1);
  const predecessorHead = new Uint32Array(nodeCount + 1);
  const predecessorFrom = new Uint32Array(edgeCount + 1);
  const predecessorNext = new Uint32Array(edgeCount + 1);
  const stackOrdinal = new Uint32Array(nodeCount);
  const stackEdge = new Uint32Array(nodeCount);
  const stackEnd = new Uint32Array(nodeCount);

  let reachable = 1;
  let predecessorCount = 0;
  let ignoredWeakEdges = 0;
  let stackSize = 1;
  dfsByOrdinal[0] = 1;
  vertex[1] = 0;
  stackOrdinal[0] = 0;
  stackEdge[0] = edgeStarts[0]!;
  stackEnd[0] = edgeStarts[1]!;

  while (stackSize > 0) {
    const stackIndex = stackSize - 1;
    const cursor = stackEdge[stackIndex]!;
    if (cursor >= stackEnd[stackIndex]!) {
      stackSize--;
      continue;
    }
    stackEdge[stackIndex] = cursor + edgeFieldCount;
    if (snapshot.edges[cursor + edgeTypeIndex] === weakEdgeType) {
      ignoredWeakEdges++;
      continue;
    }

    const targetOffset = snapshot.edges[cursor + edgeTargetIndex]!;
    if (targetOffset % nodeFieldCount !== 0) {
      throw new Error(`Heap snapshot edge target ${targetOffset} is not node-aligned`);
    }
    const targetOrdinal = targetOffset / nodeFieldCount;
    if (targetOrdinal < 0 || targetOrdinal >= nodeCount) {
      throw new Error(`Heap snapshot edge target ${targetOrdinal} is out of range`);
    }
    const sourceDfs = dfsByOrdinal[stackOrdinal[stackIndex]!]!;
    let targetDfs = dfsByOrdinal[targetOrdinal]!;
    if (targetDfs === 0) {
      targetDfs = ++reachable;
      dfsByOrdinal[targetOrdinal] = targetDfs;
      vertex[targetDfs] = targetOrdinal;
      parent[targetDfs] = sourceDfs;
      stackOrdinal[stackSize] = targetOrdinal;
      stackEdge[stackSize] = edgeStarts[targetOrdinal]!;
      stackEnd[stackSize] = edgeStarts[targetOrdinal + 1]!;
      stackSize++;
    }

    predecessorCount++;
    predecessorFrom[predecessorCount] = sourceDfs;
    predecessorNext[predecessorCount] = predecessorHead[targetDfs]!;
    predecessorHead[targetDfs] = predecessorCount;
  }

  const semi = new Uint32Array(reachable + 1);
  const label = new Uint32Array(reachable + 1);
  const ancestor = new Uint32Array(reachable + 1);
  const immediateDominator = new Uint32Array(reachable + 1);
  const bucketHead = new Uint32Array(reachable + 1);
  const bucketNext = new Uint32Array(reachable + 1);
  const compressionPath = new Uint32Array(reachable + 1);
  for (let index = 1; index <= reachable; index++) {
    semi[index] = index;
    label[index] = index;
  }

  const evaluate = (node: number): number => {
    if (ancestor[node] === 0) return label[node]!;
    let cursor = node;
    let depth = 0;
    while (ancestor[ancestor[cursor]!] !== 0) {
      compressionPath[depth++] = cursor;
      cursor = ancestor[cursor]!;
    }
    while (depth > 0) {
      const current = compressionPath[--depth]!;
      const ancestorLabel = label[ancestor[current]!]!;
      if (semi[ancestorLabel]! < semi[label[current]!]!) label[current] = ancestorLabel;
      ancestor[current] = ancestor[ancestor[current]!]!;
    }
    return label[node]!;
  };

  for (let node = reachable; node >= 2; node--) {
    for (let edge = predecessorHead[node]!; edge !== 0; edge = predecessorNext[edge]!) {
      const candidate = evaluate(predecessorFrom[edge]!);
      if (semi[candidate]! < semi[node]!) semi[node] = semi[candidate]!;
    }
    const semiNode = semi[node]!;
    bucketNext[node] = bucketHead[semiNode]!;
    bucketHead[semiNode] = node;
    const parentNode = parent[node]!;
    ancestor[node] = parentNode;
    let bucketNode = bucketHead[parentNode]!;
    bucketHead[parentNode] = 0;
    while (bucketNode !== 0) {
      const next = bucketNext[bucketNode]!;
      const candidate = evaluate(bucketNode);
      immediateDominator[bucketNode] =
        semi[candidate]! < semi[bucketNode]! ? candidate : parentNode;
      bucketNode = next;
    }
  }

  for (let node = 2; node <= reachable; node++) {
    if (immediateDominator[node] !== semi[node]) {
      immediateDominator[node] = immediateDominator[immediateDominator[node]!]!;
    }
  }

  const retainedSize = new Float64Array(reachable + 1);
  const dominatedNodes = new Uint32Array(reachable + 1);
  let reachableSelfSize = 0;
  for (let dfs = 1; dfs <= reachable; dfs++) {
    const ordinal = vertex[dfs]!;
    const selfSize = snapshot.nodes[ordinal * nodeFieldCount + nodeSelfSizeIndex]!;
    retainedSize[dfs] = selfSize;
    dominatedNodes[dfs] = 1;
    reachableSelfSize += selfSize;
  }
  for (let dfs = reachable; dfs >= 2; dfs--) {
    const dominator = immediateDominator[dfs]!;
    retainedSize[dominator] = retainedSize[dominator]! + retainedSize[dfs]!;
    dominatedNodes[dominator] = dominatedNodes[dominator]! + dominatedNodes[dfs]!;
  }

  const candidates: HeapDominator[] = [];
  for (let dfs = 2; dfs <= reachable; dfs++) {
    const ordinal = vertex[dfs]!;
    const offset = ordinal * nodeFieldCount;
    const type = nodeTypes[snapshot.nodes[offset + nodeTypeIndex]!] ?? '<unknown>';
    if (type === 'synthetic') continue;
    const name = snapshot.strings[snapshot.nodes[offset + nodeNameIndex]!] ?? '<unknown>';
    candidates.push({
      rank: 0,
      nodeIndex: ordinal,
      type,
      name,
      id: snapshot.nodes[offset + nodeIdIndex]!,
      selfSize: snapshot.nodes[offset + nodeSelfSizeIndex]!,
      retainedSize: retainedSize[dfs]!,
      dominatedNodes: dominatedNodes[dfs]!,
    });
  }
  candidates.sort(
    (left, right) => right.retainedSize - left.retainedSize || right.selfSize - left.selfSize,
  );
  const dominators = candidates.slice(0, Math.max(0, limit));
  dominators.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  return {
    snapshotPath,
    nodeCount,
    edgeCount,
    reachableNodeCount: reachable,
    reachableSelfSize,
    ignoredWeakEdges,
    dominators,
  };
}

export async function analyzeHeapSnapshotFile(
  snapshotPath: string,
  limit = 25,
): Promise<HeapDominatorReport> {
  const contents = await readFile(snapshotPath, 'utf8');
  return analyzeHeapSnapshot(JSON.parse(contents) as unknown, snapshotPath, limit);
}
