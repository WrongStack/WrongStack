import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeGovernanceServiceRequest,
  GOVERNANCE_SERVICE_PROTOCOL_VERSION,
  GovernanceProjectService,
  type GovernanceServiceCapability,
  PLAN_VERSION_SCHEMA_VERSION,
  SqliteGovernanceEventStore,
  TASK_CONTRACT_SCHEMA_VERSION,
} from '../src/index.js';

function contract() {
  return {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    taskId: 'task-1',
    contractVersion: 1,
    projectId: 'project-1',
    sourceRequest: 'Strictly decode an unknown transport request.',
    policyVersion: 'policy-1',
    repository: { rootIdentity: 'repo-hash', baselinePolicy: 'required' },
    requirements: [
      { id: 'req-1', text: 'Reject injected fields.', acceptanceCriteriaIds: ['ac-1'] },
    ],
    acceptanceCriteria: [
      { id: 'ac-1', statement: 'Unknown fields fail closed.', evidenceKinds: ['test'] },
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

function createRequest() {
  return {
    protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
    requestId: 'request-create',
    type: 'submit_command',
    command: {
      type: 'create_task',
      commandId: 'command-create',
      taskId: 'task-1',
      expectedRevision: 0,
      actor: 'model',
      issuedAt: '2026-08-01T13:00:00.000Z',
      projectId: 'project-1',
      contract: contract(),
    },
  };
}

function transitionRequest() {
  return {
    protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
    requestId: 'request-transition',
    type: 'submit_command',
    command: {
      type: 'transition_task',
      commandId: 'command-transition',
      taskId: 'missing-task',
      expectedRevision: 0,
      actor: 'model',
      issuedAt: '2026-08-01T13:01:00.000Z',
      to: 'scoped',
    },
  };
}

function plan() {
  return {
    schemaVersion: PLAN_VERSION_SCHEMA_VERSION,
    planId: 'plan-1',
    taskId: 'task-1',
    planVersion: 1,
    parentPlanVersion: null,
    contractVersion: 1,
    createdBy: 'model',
    createdAt: '2026-08-01T13:02:00.000Z',
    changeReason: 'Initial plan.',
    steps: [
      {
        id: 'step-1',
        title: 'Decode',
        description: 'Decode the wire request.',
        operations: ['file_edit'],
        expectedPaths: ['packages/governance/src/protocol-decoder.ts'],
        requirementIds: ['req-1'],
        acceptanceCriteriaIds: ['ac-1'],
        requiredCheckIds: ['check-1'],
      },
    ],
    edges: [],
  };
}

function client(...capabilities: GovernanceServiceCapability[]) {
  return { clientId: 'wire-test', capabilities: new Set(capabilities) };
}

const temporaryDirectories: string[] = [];

function openService(): GovernanceProjectService {
  const directory = mkdtempSync(join(tmpdir(), 'wrongstack-governance-wire-'));
  temporaryDirectories.push(directory);
  return new GovernanceProjectService(
    'project-1',
    SqliteGovernanceEventStore.open(join(directory, 'governance.sqlite')),
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('governance service protocol decoder', () => {
  it('decodes and deeply freezes a valid model command', () => {
    const decoded = decodeGovernanceServiceRequest(transitionRequest());
    expect(decoded).toMatchObject({
      decoded: true,
      request: { type: 'submit_command', command: { actor: 'model', to: 'scoped' } },
    });
    if (!decoded.decoded || decoded.request.type !== 'submit_command') return;
    expect(Object.isFrozen(decoded.request)).toBe(true);
    expect(Object.isFrozen(decoded.request.command)).toBe(true);
  });

  it('routes valid unknown input through the strict service boundary', () => {
    const service = openService();
    expect(service.handleUnknown(transitionRequest(), client('command_submit'))).toMatchObject({
      ok: true,
      result: {
        type: 'command_result',
        execution: { decision: { accepted: false, code: 'task_missing' } },
      },
    });
    service.close();
  });

  it('keeps low-risk model task creation autonomous through the wire decoder', () => {
    const service = openService();
    expect(service.handleUnknown(createRequest(), client('command_submit'))).toMatchObject({
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

  it('rejects request-supplied capabilities and trusted decision facts', () => {
    const service = openService();
    expect(
      service.handleUnknown(
        {
          ...transitionRequest(),
          capabilities: ['command_submit'],
          decisionContext: { transitionFacts: { snapshotCurrent: true } },
        },
        client('command_submit'),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_request',
        details: [
          { code: 'unknown_field', path: '$.capabilities' },
          { code: 'unknown_field', path: '$.decisionContext' },
        ],
      },
    });
    service.close();
  });

  it('strictly decodes capability administration without accepting issuer injection', () => {
    const decoded = decodeGovernanceServiceRequest({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'request-issue-grant',
      type: 'issue_capability_grant',
      clientId: 'model-reader',
      capabilities: ['task_read'],
      ttlMs: 30_000,
    });
    expect(decoded).toMatchObject({
      decoded: true,
      request: { clientId: 'model-reader', capabilities: ['task_read'], ttlMs: 30_000 },
    });
    if (decoded.decoded && decoded.request.type === 'issue_capability_grant') {
      expect(Object.isFrozen(decoded.request)).toBe(true);
      expect(Object.isFrozen(decoded.request.capabilities)).toBe(true);
    }

    expect(
      decodeGovernanceServiceRequest({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'request-forged-issuer',
        type: 'issue_capability_grant',
        clientId: 'model-reader',
        issuedBy: 'model-selected-policy',
        capabilities: ['task_read', 'task_read'],
        ttlMs: 30_000,
      }),
    ).toMatchObject({
      decoded: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'unknown_field', path: '$.issuedBy' }),
        expect.objectContaining({ code: 'semantic_invalid', path: '$.capabilities[1]' }),
      ]),
    });
    expect(
      decodeGovernanceServiceRequest({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'request-unbounded-grant-list',
        type: 'list_capability_grants',
        cursor: '../other-project',
        limit: 101,
      }),
    ).toMatchObject({
      decoded: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_value', path: '$.cursor' }),
        expect.objectContaining({ code: 'resource_limit', path: '$.limit' }),
      ]),
    });
  });

  it('rejects trusted facts hidden inside a model command', () => {
    const request = transitionRequest();
    const decoded = decodeGovernanceServiceRequest({
      ...request,
      command: {
        ...request.command,
        transitionFacts: { snapshotCurrent: true, requiredEvidenceSatisfied: true },
      },
    });
    expect(decoded).toMatchObject({
      decoded: false,
      issues: [{ code: 'unknown_field', path: '$.command.transitionFacts' }],
    });
  });

  it('rejects unknown fields nested inside a task contract', () => {
    const request = createRequest();
    const decoded = decodeGovernanceServiceRequest({
      ...request,
      command: {
        ...request.command,
        contract: {
          ...request.command.contract,
          repository: { ...request.command.contract.repository, secretAccess: true },
        },
      },
    });
    expect(decoded).toMatchObject({
      decoded: false,
      issues: [{ code: 'unknown_field', path: '$.command.contract.repository.secretAccess' }],
    });
  });

  it('applies semantic task-contract validation after structural decoding', () => {
    const request = createRequest();
    const decoded = decodeGovernanceServiceRequest({
      ...request,
      command: {
        ...request.command,
        contract: {
          ...request.command.contract,
          autonomy: { ...request.command.contract.autonomy, allowedPaths: [] },
        },
      },
    });
    expect(decoded).toMatchObject({
      decoded: false,
      issues: [{ code: 'semantic_invalid', path: '$.command.contract.autonomy.allowedPaths' }],
    });
  });

  it('rejects unknown fields nested inside plan steps', () => {
    const value = plan();
    const decoded = decodeGovernanceServiceRequest({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'request-plan',
      type: 'submit_command',
      command: {
        type: 'attach_plan_version',
        commandId: 'command-plan',
        taskId: 'task-1',
        expectedRevision: 1,
        actor: 'model',
        issuedAt: '2026-08-01T13:03:00.000Z',
        plan: { ...value, steps: [{ ...value.steps[0], skipVerification: true }] },
      },
    });
    expect(decoded).toMatchObject({
      decoded: false,
      issues: [{ code: 'unknown_field', path: '$.command.plan.steps[0].skipVerification' }],
    });
  });

  it('accepts bounded observation payloads and records no canonical task state', () => {
    const service = openService();
    const request = {
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'request-observation',
      type: 'record_observation',
      observation: {
        observationId: 'legacy-event-1',
        projectId: 'project-1',
        taskId: 'legacy-task',
        source: 'wire-test',
        category: 'tool_invoked',
        observedAt: '2026-08-01T13:04:00.000Z',
        payload: { tool: 'shell', outcome: { exitCode: 0, outputBytes: 42 } },
      },
    };
    expect(service.handleUnknown(request, client('shadow_observe'))).toMatchObject({
      ok: true,
      result: { type: 'observation_result', result: { handled: true } },
    });
    expect(
      service.handleUnknown(
        {
          protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
          requestId: 'request-read',
          type: 'read_task',
          taskId: 'legacy-task',
        },
        client('task_read'),
      ),
    ).toMatchObject({ ok: true, result: { type: 'task', task: null } });
    service.close();
  });

  it('rejects unsupported protocol versions and excessive JSON nesting', () => {
    expect(
      decodeGovernanceServiceRequest({
        protocolVersion: 99,
        requestId: 'request-version',
        type: 'health',
      }),
    ).toMatchObject({
      decoded: false,
      issues: [{ code: 'invalid_value', path: '$.protocolVersion' }],
    });

    let payload: Record<string, unknown> = {};
    for (let depth = 0; depth < 35; depth += 1) payload = { nested: payload };
    const decoded = decodeGovernanceServiceRequest({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'request-depth',
      type: 'record_observation',
      observation: {
        observationId: 'legacy-event-depth',
        projectId: 'project-1',
        taskId: null,
        source: 'legacy-director',
        category: 'failure_reported',
        observedAt: '2026-08-01T13:05:00.000Z',
        payload,
      },
    });
    expect(decoded).toMatchObject({
      decoded: false,
      issues: [expect.objectContaining({ code: 'resource_limit' })],
    });
  });
});
