import type { GovernanceObservation } from './event-store.js';
import type { GovernanceCommand } from './task-aggregate.js';

export const GOVERNANCE_SERVICE_PROTOCOL_VERSION = 1 as const;

export const GOVERNANCE_SERVICE_CAPABILITIES = [
  'task_read',
  'audit_read',
  'command_submit',
  'shadow_observe',
  'workspace_snapshot_record',
  'runtime_attach',
  'runtime_attachment_release',
  'daemon_status_read',
  'capability_admin',
  'daemon_control',
] as const;

export type GovernanceServiceCapability = (typeof GOVERNANCE_SERVICE_CAPABILITIES)[number];

export const GOVERNANCE_RUNTIME_MODEL_CAPABILITIES = [
  'task_read',
  'audit_read',
  'command_submit',
  'shadow_observe',
] as const satisfies readonly GovernanceServiceCapability[];

export type GovernanceRuntimeModelCapability =
  (typeof GOVERNANCE_RUNTIME_MODEL_CAPABILITIES)[number];

export interface GovernanceServiceClientContext {
  readonly clientId: string;
  /** Assigned by the transport/policy layer, never accepted from request payloads. */
  readonly capabilities: ReadonlySet<GovernanceServiceCapability>;
}

interface GovernanceServiceRequestMetadata {
  readonly protocolVersion: typeof GOVERNANCE_SERVICE_PROTOCOL_VERSION;
  readonly requestId: string;
}

export type GovernanceServiceRequest = GovernanceServiceRequestMetadata &
  (
    | { readonly type: 'health' }
    | { readonly type: 'read_task'; readonly taskId: string }
    | { readonly type: 'read_events'; readonly taskId: string }
    | { readonly type: 'read_receipt'; readonly commandId: string }
    | {
        readonly type: 'read_observations';
        readonly taskId?: string | undefined;
        readonly afterSequence?: number | undefined;
        readonly limit?: number | undefined;
      }
    | {
        readonly type: 'read_evidence_candidates';
        readonly taskId: string;
        readonly afterSequence?: number | undefined;
        readonly limit?: number | undefined;
      }
    | {
        readonly type: 'read_audit_observations';
        readonly afterSequence?: number | undefined;
        readonly limit?: number | undefined;
      }
    | { readonly type: 'read_own_capability_grant' }
    | { readonly type: 'read_daemon_status' }
    | {
        readonly type: 'request_daemon_shutdown';
        readonly expectedInstanceId: string;
        readonly reason?: string | undefined;
      }
    | { readonly type: 'submit_command'; readonly command: GovernanceCommand }
    | { readonly type: 'record_observation'; readonly observation: GovernanceObservation }
    | { readonly type: 'record_workspace_snapshot'; readonly manifestHash: string }
    | {
        readonly type: 'issue_capability_grant';
        readonly clientId: string;
        readonly capabilities: readonly GovernanceServiceCapability[];
        readonly ttlMs: number;
      }
    | {
        readonly type: 'claim_runtime_attachment';
        readonly controlClientId: string;
        readonly modelClientId: string;
        readonly modelCapabilities: readonly GovernanceRuntimeModelCapability[];
        readonly ttlMs: number;
      }
    | { readonly type: 'release_runtime_attachment' }
    | {
        readonly type: 'list_capability_grants';
        readonly cursor?: string | undefined;
        readonly limit?: number | undefined;
      }
    | {
        readonly type: 'revoke_capability_grant';
        readonly grantId: string;
        readonly reason?: string | undefined;
      }
    | {
        readonly type: 'rotate_capability_grant';
        readonly grantId: string;
        readonly ttlMs: number;
        readonly reason?: string | undefined;
      }
  );
