import type { FactCategory, GoalNode, GoalPriority, KnowledgeGraph } from './knowledge-graph.js';

export interface DecomposedSubGoal {
  title: string;
  description: string;
  priority?: GoalPriority;
  tags?: string[];
}

export function inferCategory(goal: string): FactCategory {
  const g = goal.toLowerCase();
  if (g.includes('security') || g.includes('secret') || g.includes('injection')) return 'security';
  if (g.includes('bug') || g.includes('fix') || g.includes('error')) return 'bug';
  if (g.includes('refactor') || g.includes('debt') || g.includes('architecture'))
    return 'architecture';
  if (g.includes('test') || g.includes('coverage')) return 'test';
  if (g.includes('perf') || g.includes('speed') || g.includes('optimize')) return 'perf';
  if (g.includes('deps') || g.includes('package') || g.includes('update')) return 'deps';
  return 'quality';
}

export async function decomposeGoal(goalText: string): Promise<DecomposedSubGoal[]> {
  const category = inferCategory(goalText);
  const subGoals: DecomposedSubGoal[] = [];

  if (category === 'security') {
    subGoals.push({
      title: 'Audit for secrets',
      description: 'Scan codebase for hardcoded secrets and API keys',
      priority: 'critical',
      tags: ['security'],
    });
    subGoals.push({
      title: 'Check injection vectors',
      description: 'Find eval, innerHTML, SQL concat, shell injection patterns',
      priority: 'critical',
      tags: ['security', 'injection'],
    });
    subGoals.push({
      title: 'Dependency audit',
      description: 'Run npm/pnpm audit for known CVEs',
      priority: 'high',
      tags: ['security', 'deps'],
    });
  } else if (category === 'bug') {
    subGoals.push({
      title: 'Find bugs',
      description: `Scan for bugs related to: ${goalText}`,
      priority: 'high',
      tags: ['bug'],
    });
    subGoals.push({
      title: 'Fix bugs',
      description: 'Fix discovered bugs with tests',
      priority: 'high',
      tags: ['fix'],
    });
  } else if (category === 'refactor') {
    subGoals.push({
      title: 'Plan refactor',
      description: `Analyze code structure for: ${goalText}`,
      priority: 'medium',
      tags: ['refactor', 'planning'],
    });
    subGoals.push({
      title: 'Implement refactor',
      description: 'Apply the refactoring plan',
      priority: 'medium',
      tags: ['refactor', 'implementation'],
    });
  } else {
    subGoals.push({
      title: goalText,
      description: goalText,
      priority: 'medium',
      tags: [category],
    });
  }

  return subGoals;
}

export function stringifyTaskResult(result: unknown): string {
  if (typeof result === 'string' && result.trim()) return result.trim();
  if (result === undefined || result === null) return 'Subagent completed successfully';
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export function extractFollowUps(result: string): string[] {
  const found: string[] = [];
  for (const line of result.split(/\r?\n/)) {
    const match = /^\s*(?:[-*]\s*)?(?:NEXT|TODO|FOLLOW-?UP):\s*(.+)$/i.exec(line);
    const text = match?.[1]?.trim();
    if (!text || found.includes(text)) continue;
    found.push(text);
    if (found.length >= 5) break;
  }
  return found;
}

export function buildCoordinatorVoters(selfAgentId: string) {
  return [
    { agentId: selfAgentId, agentName: 'Coordinator', role: 'coordinator', weight: 1 },
    { agentId: 'critic', agentName: 'Critic', role: 'critic', weight: 2, veto: true },
    { agentId: 'bug-hunter', agentName: 'Bug Hunter', role: 'bug-hunter', weight: 1.5 },
    {
      agentId: 'security-scanner',
      agentName: 'Security Scanner',
      role: 'security-scanner',
      weight: 1.5,
    },
    { agentId: 'audit-log', agentName: 'Audit Log', role: 'audit-log', weight: 1 },
    {
      agentId: 'refactor-planner',
      agentName: 'Refactor Planner',
      role: 'refactor-planner',
      weight: 1,
    },
  ];
}

export function goalToOptions(
  goals: GoalNode[],
): { id: string; label: string; recommended?: boolean }[] {
  return goals.slice(0, 5).map((g, i) => ({
    id: g.id,
    label: `[${g.priority}] ${g.title}`,
    recommended: i === 0,
  }));
}

export function optionToGoal(graph: KnowledgeGraph, optionId: string): GoalNode | undefined {
  return graph.get(optionId) as GoalNode | undefined;
}
