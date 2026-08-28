import type { TaskStore, TaskTracker } from '@wrongstack/core/tasking';
import type {
  Specification,
  SpecRequirement,
  TaskGraph,
  TaskNode,
  TaskPriority,
  TaskType,
} from '@wrongstack/core/types';
import { type AtomicityRuleSetConfig, assessAtomicity } from '@wrongstack/kanban';

/** Named estimate constants shared with the atomicity candidate mapping. */
const OVERVIEW_ESTIMATE_HOURS = 4;
const REQUIREMENT_ESTIMATE_HOURS: Record<string, number> = {
  critical: 8,
  high: 4,
  medium: 2,
  low: 1,
};
const API_PARENT_ESTIMATE_HOURS = 0;
const API_BASE_ESTIMATE_HOURS = 2;
const TESTS_ESTIMATE_HOURS = 4;
const DOCS_ESTIMATE_HOURS = 2;

export interface TaskGeneratorOptions {
  taskTracker: TaskTracker;
  /**
   * Opt-in (default off): derive each task's completion-gate
   * `metadata.verificationCommand` from an acceptance criterion that carries a
   * runnable-command marker (`$ <cmd>`, or `run:`/`verify:`/`cmd:` prefix). Off
   * by default so the common case stays fast — auto-running a check per task is
   * exactly the slowness the robustness initiative set out to avoid; enable it
   * explicitly (the CLI gates it behind WRONGSTACK_SDD_VERIFY_FROM_ACCEPTANCE).
   */
  verificationFromAcceptance?: boolean | undefined;
  /**
   * Opt-in atomicity annotation: stamps each generated node's
   * `metadata.atomicity` with `{ verdict, score, reasons }` from the
   * deterministic kanban rule set. Advisory only; the planning decomposer
   * consumes 'needs_decomposition' verdicts.
   */
  atomicity?: { config?: AtomicityRuleSetConfig | undefined } | undefined;
}

/** Score a generated task with the deterministic atomicity rule set. */
export function assessGeneratedTaskAtomicity(
  task: {
    title: string;
    description: string;
    estimateHours?: number | undefined;
    acceptanceCriteria?: readonly string[] | undefined;
  },
  config?: AtomicityRuleSetConfig,
): { verdict: string; score: number; reasons: string[] } {
  const criteria = task.acceptanceCriteria ?? [];
  const assessment = assessAtomicity(
    {
      title: task.title,
      description: task.description,
      estimatedHours: task.estimateHours,
      // Graph edges are wired after generation; fan-in is unknown here.
      dependencyCount: 0,
      successCriteriaCount: criteria.length,
      hasVerifiableOutput: extractVerificationCommand(criteria) !== undefined,
      childCount: 0,
    },
    config,
  );
  return {
    verdict: assessment.verdict,
    score: assessment.score,
    reasons: assessment.criteria.filter((c) => c.score < 1).map((c) => c.reason),
  };
}

/**
 * Pull a runnable verification command out of a requirement's acceptance
 * criteria. A criterion qualifies only when it carries an explicit marker —
 * `$ <cmd>` (shell-prompt style) or a `run:` / `verify:` / `cmd:` prefix — so
 * free-text criteria are never mistaken for commands. Returns the first match.
 */
export function extractVerificationCommand(criteria: readonly string[]): string | undefined {
  const marker = /^\s*(?:\$\s+|(?:run|verify|cmd)\s*:\s*)(.+\S)\s*$/i;
  for (const c of criteria) {
    const m = marker.exec(c);
    if (m?.[1]) return m[1].trim();
  }
  return undefined;
}

export interface GeneratedTask {
  specRequirementId?: string | undefined;
  title: string;
  description: string;
  type: TaskType;
  priority: TaskPriority;
  estimateHours?: number | undefined;
  tags?: string[] | undefined;
}

export class TaskGenerator {
  constructor(private readonly opts: TaskGeneratorOptions) {}

  /** metadata.atomicity payload when the option is enabled, else undefined. */
  private atomicityMetadata(task: {
    title: string;
    description: string;
    estimateHours?: number | undefined;
    acceptanceCriteria?: readonly string[] | undefined;
  }): Record<string, unknown> | undefined {
    if (!this.opts.atomicity) return undefined;
    return { atomicity: assessGeneratedTaskAtomicity(task, this.opts.atomicity.config) };
  }

  async generateFromSpec(spec: Specification): Promise<TaskGraph> {
    const graph = await this.opts.taskTracker.createGraph(spec.id, spec.title);
    graph.requiredRequirementIds = Array.from(
      new Set(
        (spec.requirements ?? []).map((requirement) => requirement.id.trim()).filter(Boolean),
      ),
    );

    // Overview task
    const overviewSection = spec.sections?.find((s) => s.type === 'overview');
    if (overviewSection?.content) {
      const overview = {
        title: `Implement: ${spec.title}`,
        description: overviewSection.content,
        estimateHours: OVERVIEW_ESTIMATE_HOURS,
      };
      const metadata = this.atomicityMetadata(overview);
      this.opts.taskTracker.addNode({
        title: overview.title,
        description: overview.description,
        type: 'feature',
        priority: 'high',
        status: 'pending',
        estimateHours: overview.estimateHours,
        ...(metadata ? { metadata } : {}),
      });
    }

    // Requirement tasks (sorted by priority)
    const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const sorted = [...(spec.requirements ?? [])].sort(
      (a, b) => (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9),
    );

    for (const req of sorted) {
      this.addRequirementTask(req);
    }

    // API endpoint tasks
    if (spec.apiEndpoints?.length) {
      const apiParent = this.opts.taskTracker.addNode({
        title: 'API Implementation',
        description: 'Implement API endpoints as specified in the spec.',
        type: 'feature',
        priority: 'high',
        status: 'pending',
        estimateHours: API_PARENT_ESTIMATE_HOURS,
      });

      for (const ep of spec.apiEndpoints) {
        const authHours = ep.auth ? 1 : 0;
        const reqHours = ep.request ? 1 : 0;
        const endpoint = {
          title: `${ep.method} ${ep.path} — ${ep.description}`,
          description: `${ep.method} ${ep.path}: ${ep.description}`,
          estimateHours: API_BASE_ESTIMATE_HOURS + authHours + reqHours,
        };
        const metadata = this.atomicityMetadata(endpoint);
        this.opts.taskTracker.addNode({
          title: endpoint.title,
          description: endpoint.description,
          type: 'feature',
          priority: 'medium',
          status: 'pending',
          estimateHours: endpoint.estimateHours,
          parentId: apiParent.id,
          ...(metadata ? { metadata } : {}),
        });
      }
    }

    // Always add closing tasks
    const testsTask = {
      title: 'Write Tests',
      description: 'Write comprehensive tests for the implemented features.',
      estimateHours: TESTS_ESTIMATE_HOURS,
    };
    const testsMetadata = this.atomicityMetadata(testsTask);
    this.opts.taskTracker.addNode({
      title: testsTask.title,
      description: testsTask.description,
      type: 'test',
      priority: 'high',
      status: 'pending',
      estimateHours: testsTask.estimateHours,
      ...(testsMetadata ? { metadata: testsMetadata } : {}),
    });

    const docsTask = {
      title: 'Update Documentation',
      description: 'Update project documentation to reflect the changes.',
      estimateHours: DOCS_ESTIMATE_HOURS,
    };
    const docsMetadata = this.atomicityMetadata(docsTask);
    this.opts.taskTracker.addNode({
      title: docsTask.title,
      description: docsTask.description,
      type: 'docs',
      priority: 'low',
      status: 'pending',
      estimateHours: docsTask.estimateHours,
      ...(docsMetadata ? { metadata: docsMetadata } : {}),
    });

    return graph;
  }

  /**
   * Repair an LLM-authored or resumed graph against the authoritative spec.
   * Missing requirements become deterministic tasks, so omission is never
   * rewarded by a smaller task list or an earlier "complete" result.
   */
  ensureRequirementCoverage(spec: Specification, graph: TaskGraph): TaskNode[] {
    if (graph.specId !== spec.id) {
      throw new Error(
        `Task graph spec mismatch: graph targets "${graph.specId}" but spec is "${spec.id}".`,
      );
    }
    graph.requiredRequirementIds = Array.from(
      new Set(
        (spec.requirements ?? []).map((requirement) => requirement.id.trim()).filter(Boolean),
      ),
    );
    const required = new Set(graph.requiredRequirementIds);
    for (const node of graph.nodes.values()) {
      if (node.specRequirementId && !required.has(node.specRequirementId)) {
        // A model typo must not permanently wedge the run. Drop the untrusted
        // mapping; the canonical requirement receives a deterministic task
        // below while the proposed task remains as additional work.
        delete node.specRequirementId;
      }
    }
    const covered = new Set(
      Array.from(graph.nodes.values()).flatMap((node) =>
        node.specRequirementId ? [node.specRequirementId] : [],
      ),
    );
    const added: TaskNode[] = [];
    for (const requirement of spec.requirements ?? []) {
      if (covered.has(requirement.id)) continue;
      added.push(this.addRequirementTask(requirement));
      covered.add(requirement.id);
    }
    return added;
  }

  private addRequirementTask(req: SpecRequirement): TaskNode {
    const estimateHours = REQUIREMENT_ESTIMATE_HOURS[req.priority] ?? 1;
    const tags: string[] = [req.type, req.priority];
    const acLines = (req.acceptanceCriteria ?? []).map((ac) => `- ${ac}`).join('\n');
    const blockedLine = req.blockedBy?.length
      ? `\n\n**Blocked by:** ${req.blockedBy.join(', ')}`
      : '';
    const description =
      `${req.description}\n\n**Type:** ${req.type}` +
      (acLines ? `\n\n**Acceptance Criteria:**\n${acLines}` : '') +
      blockedLine;
    const metadata: Record<string, unknown> = {
      ...this.atomicityMetadata({
        title: req.description,
        description,
        estimateHours,
        acceptanceCriteria: req.acceptanceCriteria ?? [],
      }),
    };
    if (this.opts.verificationFromAcceptance) {
      const command = extractVerificationCommand(req.acceptanceCriteria ?? []);
      if (command) metadata.verificationCommand = command;
    }
    return this.opts.taskTracker.addNode({
      title: req.description,
      description,
      type: 'feature',
      priority: req.priority,
      status: 'pending',
      estimateHours,
      tags,
      specRequirementId: req.id,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }

  async generateSubtasks(parentTaskId: string, spec: Specification): Promise<void> {
    const reqId = this.opts.taskTracker.getNode(parentTaskId)?.specRequirementId;
    if (!reqId) return;
    const req = spec.requirements.find((r) => r.id === reqId);
    if (!req) return;
    if (req.acceptanceCriteria.length > 0) {
      for (const criterion of req.acceptanceCriteria) {
        this.opts.taskTracker.addNode({
          title: criterion,
          description: `Verify: ${criterion}`,
          type: 'test',
          priority: 'medium',
          status: 'pending',
          parentId: parentTaskId,
        });
      }
    }
  }
}

export type { TaskStore };
