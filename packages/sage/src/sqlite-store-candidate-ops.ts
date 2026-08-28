import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  acceptSqliteCandidate,
  addSqliteCandidate,
  createSqliteCandidate,
  listSqliteCandidates,
  rejectSqliteCandidate,
  resolveSqliteCandidate,
} from './sqlite-store-candidates.js';
import type {
  CandidateDecision,
  CreateCandidateInput,
  MemoryCandidate,
  MemoryCandidateResolution,
  RememberSageInput,
  Sage,
  UpdateSageInput,
} from './types.js';

export interface SqliteCandidateHost {
  projectRoot: string;
  paths: { locksDir: string };
  stmt: (sql: string) => ReturnType<DatabaseSync['prepare']>;
  nowIso: () => string;
  runMutation: <T>(work: () => T) => Promise<T>;
  rememberSage: (input: RememberSageInput) => Promise<Sage>;
  updateSage: (id: string, input: UpdateSageInput) => Promise<Sage>;
  upsertCandidate: (candidate: MemoryCandidate, canonicalText?: string | undefined) => void;
  audit: (event: string, data?: Record<string, unknown>) => void;
}

function buildCandidateOps(host: SqliteCandidateHost) {
  return {
    projectRoot: host.projectRoot,
    candidateLockPath: (candidateId: string) =>
      path.join(host.paths.locksDir, `candidate-accept-${candidateId}`),
    stmt: (sql: string) => host.stmt(sql),
    nowIso: () => host.nowIso(),
    runMutation: <T>(work: () => T) => host.runMutation(work),
    rememberSage: (input: RememberSageInput) => host.rememberSage(input),
    updateSage: (id: string, input: UpdateSageInput) => host.updateSage(id, input),
    upsertCandidate: (candidate: MemoryCandidate, canonicalText?: string | undefined) =>
      host.upsertCandidate(candidate, canonicalText),
    audit: (event: string, data?: Record<string, unknown>) => host.audit(event, data),
  };
}

export async function addCandidateOp(host: SqliteCandidateHost, candidate: MemoryCandidate): Promise<void> {
  addSqliteCandidate(buildCandidateOps(host), candidate);
}

export async function createCandidateOp(
  host: SqliteCandidateHost,
  input: CreateCandidateInput,
): Promise<MemoryCandidate> {
  return createSqliteCandidate(buildCandidateOps(host), input);
}

export async function listCandidatesOp(
  host: SqliteCandidateHost,
  includeResolved = false,
): Promise<MemoryCandidate[]> {
  return listSqliteCandidates({ stmt: (sql) => host.stmt(sql) }, includeResolved);
}

export async function acceptCandidateOp(
  host: SqliteCandidateHost,
  candidateId: string,
): Promise<Sage | undefined> {
  return acceptSqliteCandidate(buildCandidateOps(host), candidateId);
}

export async function rejectCandidateOp(
  host: SqliteCandidateHost,
  candidateId: string,
  reason: string,
): Promise<boolean> {
  return host.runMutation(() => {
    return rejectSqliteCandidate(buildCandidateOps(host), candidateId, reason);
  });
}

export async function resolveCandidateOp(
  host: SqliteCandidateHost,
  candidateId: string,
  decision: CandidateDecision,
  reason?: string,
): Promise<MemoryCandidateResolution | undefined> {
  return resolveSqliteCandidate(buildCandidateOps(host), candidateId, decision, reason);
}
