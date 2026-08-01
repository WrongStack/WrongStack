import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthenticatedGovernanceProjectService,
  GOVERNANCE_SERVICE_PROTOCOL_VERSION,
  GovernanceCapabilityGrantRegistry,
  type GovernanceCommand,
  GovernanceProjectService,
  type GovernanceServiceCapability,
  type GovernanceServiceRequest,
  LegacyGovernanceShadowAdapter,
  SqliteGovernanceEventStore,
  TASK_CONTRACT_SCHEMA_VERSION,
  type TaskContractV1,
} from '../src/index.js';

type CreateTaskCommand = Extract<GovernanceCommand, { readonly type: 'create_task' }>;

function contract(projectId = 'project-1'): TaskContractV1 {
  return {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    taskId: 'task-1',
    contractVersion: 1,
    projectId,
    sourceRequest: 'Exercise the project-scoped governance service.',
    policyVersion: 'policy-1',
    repository: { rootIdentity: 'repo-hash', baselinePolicy: 'required' },
    requirements: [
      { id: 'req-1', text: 'Enforce service capabilities.', acceptanceCriteriaIds: ['ac-1'] },
    ],
    acceptanceCriteria: [
      { id: 'ac-1', statement: 'Unauthorized writes are rejected.', evidenceKinds: ['test'] },
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

function createTask(projectId = 'project-1'): CreateTaskCommand {
  return {
    type: 'create_task',
    commandId: 'command-create',
    taskId: 'task-1',
    expectedRevision: 0,
    actor: 'model',
    issuedAt: '2026-08-01T12:00:00.000Z',
    projectId,
    contract: contract(projectId),
  };
}

function client(...capabilities: GovernanceServiceCapability[]) {
  return { clientId: 'test-client', capabilities: new Set(capabilities) };
}

const temporaryDirectories: string[] = [];

function openService(projectId = 'project-1'): GovernanceProjectService {
  return new GovernanceProjectService(projectId, SqliteGovernanceEventStore.open(databasePath()));
}

function shadowAdapter(
  service: GovernanceProjectService,
  source: string,
): LegacyGovernanceShadowAdapter {
  const clientId = source;
  const registry = new GovernanceCapabilityGrantRegistry(service.projectId);
  const issued = registry.issue({ clientId, capabilities: ['shadow_observe'], ttlMs: 60_000 });
  return new LegacyGovernanceShadowAdapter(
    new AuthenticatedGovernanceProjectService(service, registry),
    source,
    { token: issued.token, projectId: service.projectId, clientId },
  );
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wrongstack-governance-service-'));
  temporaryDirectories.push(directory);
  return join(directory, 'governance.sqlite');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('project-scoped governance service', () => {
  it('lets a model submit a low-risk command without human intervention', () => {
    const service = openService();
    const response = service.handle(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'request-create',
        type: 'submit_command',
        command: createTask(),
      },
      client('command_submit'),
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        type: 'command_result',
        execution: {
          handled: true,
          decision: { accepted: true },
          aggregate: { state: 'draft', revision: 1 },
        },
      },
    });
    service.close();
  });

  it('denies command submission to a read-only client before state changes', () => {
    const service = openService();
    const denied = service.handle(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'request-denied',
        type: 'submit_command',
        command: createTask(),
      },
      client('task_read'),
    );

    expect(denied).toMatchObject({
      ok: false,
      error: { code: 'permission_denied' },
    });
    expect(
      service.handle(
        {
          protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
          requestId: 'request-read',
          type: 'read_task',
          taskId: 'task-1',
        },
        client('task_read'),
      ),
    ).toMatchObject({ ok: true, result: { type: 'task', task: null } });
    service.close();
  });

  it('rejects cross-project commands before they reach the event store', () => {
    const service = openService('project-1');
    expect(
      service.handle(
        {
          protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
          requestId: 'request-wrong-project',
          type: 'submit_command',
          command: createTask('project-2'),
        },
        client('command_submit'),
      ),
    ).toMatchObject({ ok: false, error: { code: 'project_mismatch' } });

    expect(
      service.handle(
        {
          protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
          requestId: 'request-read',
          type: 'read_task',
          taskId: 'task-1',
        },
        client('task_read'),
      ),
    ).toMatchObject({ ok: true, result: { task: null } });
    service.close();
  });

  it('fails closed when a misbound store contains another project task', () => {
    const store = SqliteGovernanceEventStore.open(databasePath());
    store.execute(createTask('project-2'));
    const service = new GovernanceProjectService('project-1', store);

    expect(
      service.handle(
        {
          protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
          requestId: 'request-cross-project-read',
          type: 'read_task',
          taskId: 'task-1',
        },
        client('task_read'),
      ),
    ).toMatchObject({ ok: false, error: { code: 'project_mismatch' } });
    service.close();
  });

  it('records legacy shadow observations without creating canonical state', () => {
    const service = openService();
    const shadow = shadowAdapter(service, 'legacy-director');

    expect(
      shadow.observe({
        observationId: 'legacy-event-1',
        taskId: 'legacy-task-1',
        category: 'completion_claimed',
        observedAt: '2026-08-01T12:01:00.000Z',
        payload: { legacyStatus: 'completed', model: 'provider/model' },
      }),
    ).toMatchObject({
      observed: true,
      idempotentReplay: false,
      observation: { sequence: 1, source: 'legacy-director' },
    });

    expect(
      service.handle(
        {
          protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
          requestId: 'request-state',
          type: 'read_task',
          taskId: 'legacy-task-1',
        },
        client('task_read'),
      ),
    ).toMatchObject({ ok: true, result: { task: null } });
    expect(
      service.handle(
        {
          protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
          requestId: 'request-events',
          type: 'read_events',
          taskId: 'legacy-task-1',
        },
        client('task_read'),
      ),
    ).toMatchObject({ ok: true, result: { events: [] } });
    expect(
      service.handle(
        {
          protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
          requestId: 'request-observations',
          type: 'read_observations',
          taskId: 'legacy-task-1',
        },
        client('task_read'),
      ),
    ).toMatchObject({
      ok: true,
      result: { observations: [{ category: 'completion_claimed' }] },
    });
    service.close();
  });

  it('makes shadow retries idempotent and rejects conflicting observation ids', () => {
    const service = openService();
    const shadow = shadowAdapter(service, 'legacy-goal');
    const observation = {
      observationId: 'legacy-event-1',
      category: 'status_changed' as const,
      observedAt: '2026-08-01T12:02:00.000Z',
      payload: { from: 'running', to: 'done' },
    };

    expect(shadow.observe(observation)).toMatchObject({
      observed: true,
      idempotentReplay: false,
    });
    expect(
      shadow.observe({ ...observation, payload: { to: 'done', from: 'running' } }),
    ).toMatchObject({ observed: true, idempotentReplay: true });
    expect(
      shadow.observe({ ...observation, payload: { from: 'running', to: 'failed' } }),
    ).toMatchObject({ observed: false, code: 'observation_id_conflict' });
    service.close();
  });

  it('keeps command receipts behind the independent audit capability', () => {
    const service = openService();
    service.handle(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'request-create',
        type: 'submit_command',
        command: createTask(),
      },
      client('command_submit'),
    );

    const request = {
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'request-receipt',
      type: 'read_receipt' as const,
      commandId: 'command-create',
    } as const;
    expect(service.handle(request, client('task_read'))).toMatchObject({
      ok: false,
      error: { code: 'permission_denied' },
    });
    expect(service.handle(request, client('audit_read'))).toMatchObject({
      ok: true,
      result: { type: 'receipt', receipt: { commandId: 'command-create' } },
    });
    service.close();
  });

  it('ignores forged model facts and accepts only the service-owned policy provider', () => {
    const path = databasePath();
    const untrusted = new GovernanceProjectService(
      'project-1',
      SqliteGovernanceEventStore.open(path),
    );
    untrusted.handle(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'request-create',
        type: 'submit_command',
        command: createTask(),
      },
      client('command_submit'),
    );
    const forged = {
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'request-forged-facts',
      type: 'submit_command',
      command: {
        type: 'transition_task',
        commandId: 'command-scope-forged',
        taskId: 'task-1',
        expectedRevision: 1,
        actor: 'model',
        issuedAt: '2026-08-01T12:03:00.000Z',
        to: 'scoped',
      },
      decisionContext: {
        transitionFacts: {
          contractApproved: true,
          planApproved: true,
          withinAutonomyEnvelope: true,
          authorization: 'automatic',
          executionGrantValid: true,
          snapshotCurrent: true,
          requiredEvidenceSatisfied: true,
          blockingFindings: 0,
          rollbackVerified: true,
        },
      },
    } as unknown as GovernanceServiceRequest;
    expect(untrusted.handle(forged, client('command_submit'))).toMatchObject({
      ok: true,
      result: {
        execution: {
          decision: { accepted: false, code: 'transition_facts_missing' },
          aggregate: { state: 'draft', revision: 1 },
        },
      },
    });
    untrusted.close();

    const trusted = new GovernanceProjectService(
      'project-1',
      SqliteGovernanceEventStore.open(path),
      () => ({
        transitionFacts: {
          contractApproved: true,
          planApproved: true,
          withinAutonomyEnvelope: true,
          authorization: 'automatic',
          executionGrantValid: true,
          snapshotCurrent: true,
          requiredEvidenceSatisfied: true,
          blockingFindings: 0,
          rollbackVerified: true,
        },
      }),
    );
    expect(
      trusted.handle(
        {
          protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
          requestId: 'request-trusted-facts',
          type: 'submit_command',
          command: {
            type: 'transition_task',
            commandId: 'command-scope-trusted',
            taskId: 'task-1',
            expectedRevision: 1,
            actor: 'model',
            issuedAt: '2026-08-01T12:04:00.000Z',
            to: 'scoped',
          },
        },
        client('command_submit'),
      ),
    ).toMatchObject({
      ok: true,
      result: {
        execution: {
          decision: { accepted: true },
          aggregate: { state: 'scoped', revision: 2 },
        },
      },
    });
    trusted.close();
  });
});
