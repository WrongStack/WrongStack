import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGovernanceEvidenceCandidate,
  evaluateGovernanceEvidenceCandidateObservation,
  GOVERNANCE_SERVICE_PROTOCOL_VERSION,
  GovernanceProjectService,
  SqliteGovernanceEventStore,
  type StoredGovernanceObservation,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function trace(taskId = 'task-1') {
  return {
    sessionId: 'session-1',
    task: { scope: 'kanban_task' as const, taskId, boardId: 'board-1' },
    plan: { state: 'available' as const, fingerprint: 'a'.repeat(64) },
    workspace: {
      state: 'captured' as const,
      manifestHash: 'b'.repeat(64),
      baseHead: 'c'.repeat(40),
    },
  };
}

function candidatePayload(taskId = 'task-1') {
  const binding = trace(taskId);
  return {
    ...createGovernanceEvidenceCandidate(binding, {
      toolCallId: 'tool-1',
      toolName: 'shell',
      ok: true,
      durationMs: 25,
      outputBytes: 42,
    }),
    trace: binding,
  };
}

function stored(
  payload: Readonly<Record<string, unknown>> = candidatePayload(),
): StoredGovernanceObservation {
  return {
    sequence: 1,
    observationId: 'observation-1',
    projectId: 'project-1',
    taskId: 'task-1',
    source: 'model-client-1',
    category: 'evidence_candidate',
    observedAt: '2026-08-02T12:00:00.000Z',
    recordedAt: '2026-08-02T12:00:01.000Z',
    payload,
  };
}

function openStore() {
  const directory = mkdtempSync(join(tmpdir(), 'wrongstack-evidence-ledger-'));
  temporaryDirectories.push(directory);
  return SqliteGovernanceEventStore.open(join(directory, 'governance.sqlite'));
}

describe('governance evidence candidate ledger', () => {
  it('recomputes candidate identity before making it eligible for later evaluation', () => {
    const entry = evaluateGovernanceEvidenceCandidateObservation(stored());
    const tampered = candidatePayload();
    const forged = evaluateGovernanceEvidenceCandidateObservation(
      stored({ ...tampered, candidateId: 'd'.repeat(64) }),
    );

    expect(entry).toMatchObject({
      candidateId: expect.stringMatching(/^[a-f0-9]{64}$/),
      toolCallId: 'tool-1',
      outcomeStatus: 'succeeded',
      planFingerprint: 'a'.repeat(64),
      workspaceManifestHash: 'b'.repeat(64),
      workspaceBaseHead: 'c'.repeat(40),
      evaluation: { state: 'eligible_for_evaluation', reasons: [] },
    });
    expect(forged).toMatchObject({
      evaluation: { state: 'ineligible', reasons: ['candidate_identity_mismatch'] },
    });
  });

  it('keeps incomplete and malformed observations visible but ineligible', () => {
    const incomplete = evaluateGovernanceEvidenceCandidateObservation(
      stored({
        schemaVersion: 1,
        candidateType: 'tool_execution',
        status: 'unverified',
        candidateId: null,
        binding: { state: 'incomplete', missing: ['workspace'] },
        tool: { callId: 'tool-1', name: 'shell' },
        outcome: { status: 'failed', durationMs: 10 },
        trace: { ...trace(), workspace: { state: 'not_captured' } },
      }),
    );
    const malformed = evaluateGovernanceEvidenceCandidateObservation(stored({ secret: 'raw' }));

    expect(incomplete).toMatchObject({
      candidateId: null,
      outcomeStatus: 'failed',
      evaluation: { state: 'ineligible', reasons: ['binding_incomplete'] },
    });
    expect(malformed).toMatchObject({
      candidateId: null,
      toolName: null,
      evaluation: { state: 'ineligible', reasons: ['unsupported_schema'] },
    });
    expect(JSON.stringify(malformed)).not.toContain('raw');
  });

  it('exposes a bounded task-scoped page under task_read without returning other observations', () => {
    const store = openStore();
    const service = new GovernanceProjectService('project-1', store);
    const append = (observationId: string, category: 'evidence_candidate' | 'tool_invoked') =>
      store.appendObservation({
        observationId,
        projectId: 'project-1',
        taskId: 'task-1',
        source: 'model-client-1',
        category,
        observedAt: '2026-08-02T12:00:00.000Z',
        payload: category === 'evidence_candidate' ? candidatePayload() : { phase: 'completed' },
      });
    append('candidate-1', 'evidence_candidate');
    append('tool-1', 'tool_invoked');
    append('candidate-2', 'evidence_candidate');
    const request = {
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'read-candidates-1',
      type: 'read_evidence_candidates',
      taskId: 'task-1',
      limit: 1,
    } as const;

    expect(service.handle(request, { clientId: 'none', capabilities: new Set() })).toMatchObject({
      ok: false,
      error: { code: 'permission_denied' },
    });
    const first = service.handle(request, {
      clientId: 'reader',
      capabilities: new Set(['task_read'] as const),
    });
    expect(first).toMatchObject({
      ok: true,
      result: {
        type: 'evidence_candidates',
        taskId: 'task-1',
        candidates: [{ sequence: 1, evaluation: { state: 'eligible_for_evaluation' } }],
        nextAfterSequence: 1,
      },
    });
    expect(
      service.handle(
        { ...request, requestId: 'read-candidates-2', afterSequence: 1 },
        {
          clientId: 'reader',
          capabilities: new Set(['task_read'] as const),
        },
      ),
    ).toMatchObject({
      ok: true,
      result: {
        candidates: [{ sequence: 3 }],
        nextAfterSequence: null,
      },
    });
    service.close();
  });

  it('strictly rejects oversized pages and unknown query fields', () => {
    const service = new GovernanceProjectService('project-1', openStore());
    const response = service.handleUnknown(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'read-candidates-invalid',
        type: 'read_evidence_candidates',
        taskId: 'task-1',
        limit: 101,
        filter: 'trust-model-output',
      },
      { clientId: 'reader', capabilities: new Set(['task_read']) },
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_request',
        details: expect.arrayContaining([
          expect.objectContaining({ code: 'resource_limit', path: '$.limit' }),
          expect.objectContaining({ code: 'unknown_field', path: '$.filter' }),
        ]),
      },
    });
    service.close();
  });
});
