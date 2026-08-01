import type { GovernanceObservation } from './event-store.js';
import type { GovernanceCommand } from './task-aggregate.js';

export const GOVERNANCE_SERVICE_PROTOCOL_VERSION = 1 as const;

export const GOVERNANCE_SERVICE_CAPABILITIES = [
  'task_read',
  'audit_read',
  'command_submit',
  'shadow_observe',
  'capability_admin',
  'daemon_control',
] as const;

export type GovernanceServiceCapability = (typeof GOVERNANCE_SERVICE_CAPABILITIES)[number];

export interface GovernanceServiceClientContext {
  readonly clientId: string;
  /** Assigned by the transport/policy layer, never accepted from request payloads. */
  readonly capabilities: ReadonlySet<GovernanceServiceCapability>;
}

export interface GovernanceServiceRequestMetadata {
  readonly protocolVersion: typeof GOVERNANCE_SERVICE_PROTOCOL_VERSION;
  readonly requestId: string;
}

export type GovernanceServiceRequest = GovernanceServiceRequestMetadata &
  (
    | { readonly type: 'health' }
    | { readonly type: 'read_task'; readonly taskId: string }
    | { readonly type: 'read_events'; readonly taskId: string }
    | { readonly type: 'read_receipt'; readonly commandId: string }
    | { readonly type: 'read_observations'; readonly taskId?: string | undefined }
    | { readonly type: 'read_audit_observations' }
    | { readonly type: 'read_own_capability_grant' }
    | { readonly type: 'read_daemon_status' }
    | {
        readonly type: 'request_daemon_shutdown';
        readonly expectedInstanceId: string;
        readonly reason?: string | undefined;
      }
    | { readonly type: 'submit_command'; readonly command: GovernanceCommand }
    | { readonly type: 'record_observation'; readonly observation: GovernanceObservation }
    | {
        readonly type: 'issue_capability_grant';
        readonly clientId: string;
        readonly capabilities: readonly GovernanceServiceCapability[];
        readonly ttlMs: number;
      }
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
