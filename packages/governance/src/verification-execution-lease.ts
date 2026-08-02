import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { VerificationRunContract } from './verification-run-contract.js';
import type { WorkspaceSnapshotFenceDescriptor } from './workspace-snapshot-fence.js';

export const VERIFICATION_EXECUTION_LEASE_SCHEMA_VERSION = 1 as const;

export interface VerificationExecutionLeaseCredential {
  readonly leaseId: string;
  readonly secret: string;
}

export interface VerificationExecutionLeaseDescriptor {
  readonly schemaVersion: typeof VERIFICATION_EXECUTION_LEASE_SCHEMA_VERSION;
  readonly leaseId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly verifierClientId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface VerificationExecutionBinding {
  readonly runId: string;
  readonly taskId: string;
  readonly verifierClientId: string;
  readonly planFingerprint: string;
  readonly workspaceManifestHash: string;
}

export interface VerificationLeaseIssuancePrecondition {
  readonly taskRevision: number;
  readonly activeContractVersion: number;
  readonly activePlanVersion: number;
  readonly activePlanFingerprint: string;
  readonly workflowState: 'proposed_complete' | 'verifying';
  readonly workspaceManifestHash: string;
  readonly workspaceSnapshot: WorkspaceSnapshotFenceDescriptor;
  readonly candidateObservation: {
    readonly sequence: number;
    readonly observationId: string;
  };
}

export interface VerificationExecutionLeaseConsumption {
  readonly leaseId: string;
  readonly runId: string;
  readonly verifierClientId: string;
  readonly consumedAt: string;
  readonly bindingHash: string;
}

export type IssueVerificationExecutionLeaseResult =
  | {
      readonly issued: true;
      readonly run: VerificationRunContract;
      readonly lease: VerificationExecutionLeaseDescriptor;
      readonly credential: VerificationExecutionLeaseCredential;
    }
  | {
      readonly issued: false;
      readonly code:
        | 'run_invalid'
        | 'run_conflict'
        | 'run_expired'
        | 'already_issued'
        | 'canonical_task_missing'
        | 'canonical_state_invalid'
        | 'canonical_state_mismatch'
        | 'canonical_candidate_missing'
        | 'canonical_candidate_invalid'
        | 'canonical_candidate_mismatch'
        | 'workspace_snapshot_missing'
        | 'workspace_snapshot_invalid'
        | 'workspace_snapshot_stale'
        | 'workspace_mismatch';
      readonly message: string;
    };

export type ConsumeVerificationExecutionLeaseResult =
  | {
      readonly authorized: true;
      readonly run: VerificationRunContract;
      readonly consumption: VerificationExecutionLeaseConsumption;
    }
  | {
      readonly authorized: false;
      readonly code:
        | 'invalid_credential'
        | 'already_consumed'
        | 'expired'
        | 'binding_mismatch'
        | 'stored_run_invalid';
      readonly message: string;
    };

export type VerificationExecutionLeaseStatus =
  | { readonly state: 'missing'; readonly leaseId: string }
  | {
      readonly state: 'active' | 'expired' | 'consumed';
      readonly lease: VerificationExecutionLeaseDescriptor;
      readonly consumption: VerificationExecutionLeaseConsumption | null;
    };

export function verificationExecutionLeaseId(runId: string): string {
  return createHash('sha256')
    .update(`wrongstack-verification-lease-v1\0${runId}`, 'utf8')
    .digest('hex');
}

export function createVerificationExecutionLeaseSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function verificationExecutionLeaseSecretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function verificationExecutionBindingHash(binding: VerificationExecutionBinding): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        runId: binding.runId,
        taskId: binding.taskId,
        verifierClientId: binding.verifierClientId,
        planFingerprint: binding.planFingerprint,
        workspaceManifestHash: binding.workspaceManifestHash,
      }),
      'utf8',
    )
    .digest('hex');
}

export function verificationExecutionLeaseSecretMatches(
  secret: string,
  expectedHash: string,
): boolean {
  const actual = Buffer.from(verificationExecutionLeaseSecretHash(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
