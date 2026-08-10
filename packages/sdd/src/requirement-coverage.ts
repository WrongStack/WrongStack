import type { Specification, TaskGraph } from '@wrongstack/core/types';

export interface TaskGraphRequirementCoverage {
  valid: boolean;
  requiredRequirementIds: string[];
  missingRequirementIds: string[];
  unknownRequirementIds: string[];
}

function uniqueIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
}

/** Deterministic requirement-to-task coverage; no model judgment is involved. */
export function evaluateTaskGraphRequirementCoverage(
  graph: TaskGraph,
  requiredIds: readonly string[] = graph.requiredRequirementIds ?? [],
): TaskGraphRequirementCoverage {
  const requiredRequirementIds = uniqueIds(requiredIds);
  const required = new Set(requiredRequirementIds);
  const mapped = uniqueIds(
    Array.from(graph.nodes.values()).flatMap((node) =>
      node.specRequirementId ? [node.specRequirementId] : [],
    ),
  );
  const mappedSet = new Set(mapped);
  const missingRequirementIds = requiredRequirementIds.filter((id) => !mappedSet.has(id));
  const unknownRequirementIds = mapped.filter((id) => !required.has(id));
  return {
    valid: missingRequirementIds.length === 0 && unknownRequirementIds.length === 0,
    requiredRequirementIds,
    missingRequirementIds,
    unknownRequirementIds,
  };
}

export function assertTaskGraphRequirementCoverage(
  graph: TaskGraph,
  requiredIds: readonly string[] = graph.requiredRequirementIds ?? [],
): void {
  const result = evaluateTaskGraphRequirementCoverage(graph, requiredIds);
  if (result.valid) return;
  const problems = [
    result.missingRequirementIds.length
      ? `missing task coverage for ${result.missingRequirementIds.join(', ')}`
      : '',
    result.unknownRequirementIds.length
      ? `tasks reference unknown requirements ${result.unknownRequirementIds.join(', ')}`
      : '',
  ].filter(Boolean);
  throw new Error(`Task graph requirement coverage is invalid: ${problems.join('; ')}.`);
}

export function assertSpecTaskGraphCoverage(graph: TaskGraph, spec: Specification): void {
  if (graph.specId !== spec.id) {
    throw new Error(
      `Task graph spec mismatch: graph targets "${graph.specId}" but execution received "${spec.id}".`,
    );
  }
  assertTaskGraphRequirementCoverage(
    graph,
    (spec.requirements ?? []).map((requirement) => requirement.id),
  );
}

/** Fail before dispatch when dependency edges cannot form an executable DAG. */
export function assertTaskGraphExecutionIntegrity(graph: TaskGraph): void {
  const dependencies = graph.edges.filter((edge) => edge.type === 'depends_on');
  for (const edge of dependencies) {
    if (!graph.nodes.has(edge.from) || !graph.nodes.has(edge.to)) {
      throw new Error(
        `Task graph dependency ${edge.id} references a missing task (${edge.from} -> ${edge.to}).`,
      );
    }
    if (edge.from === edge.to) {
      throw new Error(`Task graph dependency ${edge.id} is a self-cycle.`);
    }
  }

  const indegree = new Map(Array.from(graph.nodes.keys(), (id) => [id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of dependencies) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const ready = Array.from(indegree.entries())
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift()!;
    visited += 1;
    for (const dependent of outgoing.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
  }
  if (visited !== graph.nodes.size) {
    throw new Error('Task graph dependency cycle prevents deterministic execution.');
  }
}
