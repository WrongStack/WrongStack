import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WorkspaceCheckpointRef } from '@wrongstack/core/types';

export const MAX_GOVERNANCE_PLAN_BYTES = 1024 * 1024;
const MAX_GOVERNANCE_ACTIVE_STEP_IDS = 128;

type GovernancePlanTrace =
  | { readonly state: 'missing' | 'invalid' | 'unreadable' }
  | { readonly state: 'refreshing'; readonly observedAt: string }
  | {
      readonly state: 'available';
      readonly schemaVersion: 1;
      readonly fingerprint: string;
      readonly updatedAt?: string | undefined;
      readonly observedAt: string;
      readonly itemCount: number;
      readonly openCount: number;
      readonly inProgressCount: number;
      readonly doneCount: number;
      readonly activeStepIds: readonly string[];
      readonly activeStepIdsTruncated: boolean;
    };

type GovernanceWorkspaceTrace =
  | { readonly state: 'not_captured' }
  | {
      readonly state: 'unavailable';
      readonly promptIndex: number;
      readonly observedAt: string;
    }
  | {
      readonly state: 'captured';
      readonly promptIndex: number;
      readonly manifestHash: string;
      readonly baseHead: string;
      readonly entryCount: number;
      readonly unresolvedCount: number;
      readonly capturedAt: string;
      readonly coverage: WorkspaceCheckpointRef['coverage'];
    };

export interface GovernanceTraceContextSnapshot {
  readonly sessionId: string;
  readonly task:
    | { readonly scope: 'session' }
    | {
        readonly scope: 'kanban_task';
        readonly taskId: string;
        readonly boardId: string | null;
      };
  readonly plan: GovernancePlanTrace;
  readonly workspace: GovernanceWorkspaceTrace;
}

export interface GovernanceTraceContext {
  matchesPlanPath(candidate: string): boolean;
  refreshPlan(): Promise<GovernancePlanTrace>;
  updateWorkspaceCheckpoint(
    promptIndex: number,
    observedAt: string,
    checkpoint: WorkspaceCheckpointRef | undefined,
  ): void;
  snapshot(taskId: string | null, boardId?: string | undefined): GovernanceTraceContextSnapshot;
}

interface GovernanceTraceContextDependencies {
  readonly readFile: (filePath: string) => Promise<string>;
  readonly now: () => string;
}

const DEFAULT_DEPENDENCIES: GovernanceTraceContextDependencies = {
  readFile: (filePath) => fs.readFile(filePath, 'utf8'),
  now: () => new Date().toISOString(),
};

function normalizedPath(input: string): string {
  const resolved = path.resolve(input);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function planTrace(raw: string, observedAt: string): GovernancePlanTrace {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return Object.freeze({ state: 'invalid' });
  }
  if (!parsed || typeof parsed !== 'object') return Object.freeze({ state: 'invalid' });
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== 1 || !Array.isArray(record['items'])) {
    return Object.freeze({ state: 'invalid' });
  }
  const statuses = { open: 0, in_progress: 0, done: 0 };
  const activeStepIds: string[] = [];
  for (const entry of record['items']) {
    if (!entry || typeof entry !== 'object') return Object.freeze({ state: 'invalid' });
    const item = entry as Record<string, unknown>;
    const id = item['id'];
    const status = item['status'];
    if (
      typeof id !== 'string' ||
      (status !== 'open' && status !== 'in_progress' && status !== 'done')
    ) {
      return Object.freeze({ state: 'invalid' });
    }
    statuses[status]++;
    if (status === 'in_progress' && activeStepIds.length < MAX_GOVERNANCE_ACTIVE_STEP_IDS) {
      activeStepIds.push(id);
    }
  }
  return Object.freeze({
    state: 'available',
    schemaVersion: 1,
    fingerprint: createHash('sha256').update(raw, 'utf8').digest('hex'),
    ...(validTimestamp(record['updatedAt']) ? { updatedAt: record['updatedAt'] } : {}),
    observedAt,
    itemCount: record['items'].length,
    openCount: statuses.open,
    inProgressCount: statuses.in_progress,
    doneCount: statuses.done,
    activeStepIds: Object.freeze(activeStepIds),
    activeStepIdsTruncated: statuses.in_progress > activeStepIds.length,
  });
}

class LiveGovernanceTraceContext implements GovernanceTraceContext {
  readonly #sessionId: string;
  readonly #planPath: string;
  readonly #dependencies: GovernanceTraceContextDependencies;
  #plan: GovernancePlanTrace = Object.freeze({ state: 'missing' });
  #workspace: GovernanceWorkspaceTrace = Object.freeze({ state: 'not_captured' });
  #planGeneration = 0;

  constructor(
    sessionId: string,
    planPath: string,
    dependencies: GovernanceTraceContextDependencies,
  ) {
    this.#sessionId = sessionId;
    this.#planPath = normalizedPath(planPath);
    this.#dependencies = dependencies;
  }

  matchesPlanPath(candidate: string): boolean {
    return normalizedPath(candidate) === this.#planPath;
  }

  async refreshPlan(): Promise<GovernancePlanTrace> {
    const generation = ++this.#planGeneration;
    this.#plan = Object.freeze({ state: 'refreshing', observedAt: this.#dependencies.now() });
    let next: GovernancePlanTrace;
    try {
      const raw = await this.#dependencies.readFile(this.#planPath);
      next =
        Buffer.byteLength(raw, 'utf8') > MAX_GOVERNANCE_PLAN_BYTES
          ? Object.freeze({ state: 'unreadable' })
          : planTrace(raw, this.#dependencies.now());
    } catch (error) {
      next = Object.freeze({
        state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable',
      });
    }
    if (generation === this.#planGeneration) this.#plan = next;
    return this.#plan;
  }

  updateWorkspaceCheckpoint(
    promptIndex: number,
    observedAt: string,
    checkpoint: WorkspaceCheckpointRef | undefined,
  ): void {
    this.#workspace = checkpoint
      ? Object.freeze({
          state: 'captured',
          promptIndex,
          manifestHash: checkpoint.manifestHash,
          baseHead: checkpoint.baseHead,
          entryCount: checkpoint.entryCount,
          unresolvedCount: checkpoint.unresolvedCount,
          capturedAt: checkpoint.capturedAt,
          coverage: checkpoint.coverage,
        })
      : Object.freeze({ state: 'unavailable', promptIndex, observedAt });
  }

  snapshot(taskId: string | null, boardId?: string | undefined): GovernanceTraceContextSnapshot {
    return Object.freeze({
      sessionId: this.#sessionId,
      task: taskId
        ? Object.freeze({ scope: 'kanban_task', taskId, boardId: boardId ?? null })
        : Object.freeze({ scope: 'session' }),
      plan: this.#plan,
      workspace: this.#workspace,
    });
  }
}

export async function createGovernanceTraceContext(
  input: { readonly sessionId: string; readonly planPath: string },
  dependencies: GovernanceTraceContextDependencies = DEFAULT_DEPENDENCIES,
): Promise<GovernanceTraceContext> {
  const context = new LiveGovernanceTraceContext(input.sessionId, input.planPath, dependencies);
  await context.refreshPlan();
  return context;
}
