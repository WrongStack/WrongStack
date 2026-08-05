import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';
import {
  type GovernanceCommand,
  type GovernanceDecisionContext,
  SqliteGovernanceEventStore,
  TASK_CONTRACT_SCHEMA_VERSION,
  type TaskContractV1,
  type TransitionFacts,
} from '../src/index.js';

const facts: TransitionFacts = {
  contractApproved: true,
  planApproved: true,
  withinAutonomyEnvelope: true,
  authorization: 'automatic',
  executionGrantValid: true,
  snapshotCurrent: true,
  requiredEvidenceSatisfied: true,
  blockingFindings: 0,
  rollbackVerified: true,
};

type CreateTaskCommand = Extract<GovernanceCommand, { readonly type: 'create_task' }>;
type TransitionTaskCommand = Extract<GovernanceCommand, { readonly type: 'transition_task' }>;

function contract(): TaskContractV1 {
  return {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    taskId: 'task-1',
    contractVersion: 1,
    projectId: 'project-1',
    sourceRequest: 'Persist deterministic governance events without runtime integration.',
    policyVersion: 'policy-1',
    repository: { rootIdentity: 'repo-hash', baselinePolicy: 'required' },
    requirements: [
      { id: 'req-1', text: 'Persist canonical events.', acceptanceCriteriaIds: ['ac-1'] },
    ],
    acceptanceCriteria: [
      { id: 'ac-1', statement: 'State survives reopen.', evidenceKinds: ['test'] },
    ],
    autonomy: {
      tier: 'A2',
      allowedOperations: ['repository_read', 'file_edit', 'focused_check'],
      humanApprovalRequiredFor: [],
      allowedPaths: ['packages/governance/**'],
      deniedPaths: [],
      budget: {
        maxChangedFiles: 10,
        maxChangedLines: 1_000,
        maxNewDependencies: 0,
        maxRetries: 3,
        maxReplans: 2,
        maxSubagents: 2,
        maxWallClockMs: 900_000,
      },
      autoAuthorizePlan: true,
      autoReplanLimit: 2,
      autoResolveReviewFixes: true,
    },
    requiredChecks: [{ id: 'check-1', kind: 'test', required: true, requirementIds: ['req-1'] }],
    requiredReviewDimensions: ['correctness'],
    rollbackClass: 'git_revert',
    assumptions: [],
    sources: {
      requirements: 'explicit_user',
      scope: 'project_policy',
      checks: 'deterministic_inference',
      autonomy: 'project_policy',
    },
  };
}

function createTask(commandId = 'command-create'): CreateTaskCommand {
  return {
    type: 'create_task',
    commandId,
    taskId: 'task-1',
    expectedRevision: 0,
    actor: 'model',
    issuedAt: '2026-08-01T10:00:00.000Z',
    projectId: 'project-1',
    contract: contract(),
  };
}

function transition(
  commandId: string,
  expectedRevision: number,
  to: 'scoped' | 'cancelled',
): TransitionTaskCommand {
  return {
    type: 'transition_task',
    commandId,
    taskId: 'task-1',
    expectedRevision,
    actor: 'model',
    issuedAt: `2026-08-01T10:00:0${expectedRevision}.000Z`,
    to,
  };
}

const context: GovernanceDecisionContext = { transitionFacts: facts };
const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wrongstack-governance-'));
  temporaryDirectories.push(directory);
  return join(directory, 'governance.sqlite');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('SQLite governance event store', () => {
  it('reconstructs canonical state after closing and reopening the database', () => {
    const path = databasePath();
    const first = SqliteGovernanceEventStore.open(path);
    expect(first.execute(createTask())).toMatchObject({
      handled: true,
      idempotentReplay: false,
      aggregate: { state: 'draft', revision: 1 },
    });
    expect(first.execute(transition('command-scope', 1, 'scoped'), context)).toMatchObject({
      handled: true,
      aggregate: { state: 'scoped', revision: 2 },
    });
    first.close();

    const reopened = SqliteGovernanceEventStore.open(path);
    expect(reopened.readTask('task-1')).toMatchObject({ state: 'scoped', revision: 2 });
    expect(reopened.readEvents('task-1')).toHaveLength(2);
    reopened.close();
  });

  it('returns the original accepted result for an idempotent retry without appending an event', () => {
    const store = SqliteGovernanceEventStore.open(databasePath());
    const command = createTask();
    const original = store.execute(command);
    const retried = store.execute({ ...command, contract: { ...command.contract } });

    expect(original).toMatchObject({ handled: true, idempotentReplay: false });
    expect(retried).toMatchObject({
      handled: true,
      idempotentReplay: true,
      aggregate: { revision: 1, state: 'draft' },
    });
    expect(store.readEvents('task-1')).toHaveLength(1);
    store.close();
  });

  it('rejects reuse of a command id with a different payload', () => {
    const store = SqliteGovernanceEventStore.open(databasePath());
    store.execute(createTask());

    expect(store.execute({ ...createTask(), projectId: 'different-project' })).toMatchObject({
      handled: false,
      code: 'command_id_conflict',
    });
    expect(store.readEvents('task-1')).toHaveLength(1);
    store.close();
  });

  it('records rejected commands and returns their historical result after state advances', () => {
    const store = SqliteGovernanceEventStore.open(databasePath());
    store.execute(createTask());
    const stale = transition('command-stale', 0, 'scoped');

    expect(store.execute(stale, context)).toMatchObject({
      handled: true,
      idempotentReplay: false,
      decision: { accepted: false, code: 'stale_revision' },
      aggregate: { revision: 1, state: 'draft' },
    });
    store.execute(transition('command-scope', 1, 'scoped'), context);
    expect(store.execute(stale, context)).toMatchObject({
      handled: true,
      idempotentReplay: true,
      decision: { accepted: false, code: 'stale_revision' },
      aggregate: { revision: 1, state: 'draft' },
    });
    expect(store.readTask('task-1')).toMatchObject({ revision: 2, state: 'scoped' });
    store.close();
  });

  it('serializes separate clients through the canonical revision', () => {
    const path = databasePath();
    const first = SqliteGovernanceEventStore.open(path);
    const second = SqliteGovernanceEventStore.open(path);
    first.execute(createTask());

    expect(first.execute(transition('command-first', 1, 'scoped'), context)).toMatchObject({
      handled: true,
      decision: { accepted: true },
      aggregate: { revision: 2 },
    });
    expect(second.execute(transition('command-second', 1, 'cancelled'), context)).toMatchObject({
      handled: true,
      decision: { accepted: false, code: 'stale_revision' },
      aggregate: { revision: 2, state: 'scoped' },
    });
    expect(second.readEvents('task-1')).toHaveLength(2);
    first.close();
    second.close();
  });

  it('stores trusted decision facts in the receipt and protects both ledgers from mutation', () => {
    const path = databasePath();
    const store = SqliteGovernanceEventStore.open(path, {
      now: () => '2026-08-01T11:00:00.000Z',
    });
    store.execute(createTask());
    store.execute(transition('command-scope', 1, 'scoped'), context);

    expect(store.readReceipt('command-scope')).toMatchObject({
      taskId: 'task-1',
      resultRevision: 2,
      recordedAt: '2026-08-01T11:00:00.000Z',
      decisionContext: { transitionFacts: { snapshotCurrent: true } },
      decision: { accepted: true },
    });

    const direct = new DatabaseSync(path);
    expect(() => direct.exec('DELETE FROM governance_events')).toThrow(/append-only/);
    expect(() => direct.exec('UPDATE governance_command_receipts SET task_id = task_id')).toThrow(
      /append-only/,
    );
    direct.close();
    store.close();
  });

  it('persists idempotent shadow observations without creating task events', () => {
    const path = databasePath();
    const first = SqliteGovernanceEventStore.open(path);
    const observation = {
      observationId: 'legacy-event-1',
      projectId: 'project-1',
      taskId: 'legacy-task-1',
      source: 'legacy-director',
      category: 'status_changed' as const,
      observedAt: '2026-08-01T11:30:00.000Z',
      payload: { status: 'completed' },
    };
    expect(first.appendObservation(observation)).toMatchObject({
      handled: true,
      idempotentReplay: false,
      observation: { sequence: 1 },
    });
    expect(first.appendObservation(observation)).toMatchObject({
      handled: true,
      idempotentReplay: true,
      observation: { sequence: 1 },
    });
    expect(first.readTask('legacy-task-1')).toBeNull();
    expect(first.readEvents('legacy-task-1')).toEqual([]);
    const direct = new DatabaseSync(path);
    expect(() => direct.exec('DELETE FROM governance_observations')).toThrow(/append-only/);
    direct.close();
    first.close();

    const reopened = SqliteGovernanceEventStore.open(path);
    expect(
      reopened.readObservationsPage({
        projectId: 'project-1',
        taskId: 'legacy-task-1',
        categories: ['status_changed'],
        afterSequence: 0,
        limit: 10,
      }),
    ).toMatchObject([
      { sequence: 1, category: 'status_changed', payload: { status: 'completed' } },
    ]);
    reopened.close();
  });

  // The observations table is append-only, so an unwindowed read grows with the
  // project forever. These pin that the window and the category filter are both
  // applied by the query rather than by the caller.
  it('windows observation reads by category and cursor', () => {
    const store = SqliteGovernanceEventStore.open(databasePath());
    const categories = ['status_changed', 'capability_grant_issued', 'tool_invoked'] as const;
    for (let index = 0; index < 12; index += 1) {
      const category = categories[index % categories.length]!;
      expect(
        store.appendObservation({
          observationId: `obs-${index}`,
          projectId: 'project-1',
          taskId: 'task-1',
          source: 'legacy-director',
          category,
          observedAt: '2026-08-01T13:05:00.000Z',
          payload: { index },
        }),
      ).toMatchObject({ handled: true });
    }

    const read = (options: { afterSequence: number; limit: number }) =>
      store.readObservationsPage({
        projectId: 'project-1',
        taskId: 'task-1',
        categories: ['status_changed', 'tool_invoked'],
        ...options,
      });

    const first = read({ afterSequence: 0, limit: 3 });
    expect(first).toHaveLength(3);
    // Only the two requested categories come back — the interleaved
    // capability_grant_issued rows never leave SQLite.
    expect(first.every((row) => row.category !== 'capability_grant_issued')).toBe(true);

    const second = read({ afterSequence: first.at(-1)!.sequence, limit: 3 });
    expect(second).toHaveLength(3);
    expect(second[0]!.sequence).toBeGreaterThan(first.at(-1)!.sequence);
    // Pages are disjoint and ordered.
    expect(new Set([...first, ...second].map((row) => row.sequence)).size).toBe(6);

    const remaining = read({ afterSequence: second.at(-1)!.sequence, limit: 50 });
    expect(first.length + second.length + remaining.length).toBe(8);

    expect(
      store.readObservationsPage({
        projectId: 'project-1',
        categories: [],
        afterSequence: 0,
        limit: 10,
      }),
    ).toEqual([]);
    expect(() =>
      store.readObservationsPage({
        projectId: 'project-1',
        categories: ['tool_invoked'],
        afterSequence: 0,
        limit: 0,
      }),
    ).toThrow(/limit must be between/);
    store.close();
  });
});
