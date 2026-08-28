import type { GovernanceAttachmentBrokerControllerSnapshot } from './attachment-broker-controller.js';
import type { GovernanceCapabilityGrant, GovernanceServiceCredential } from './capability-grant.js';
import {
  type AppendGovernanceObservationResult,
  GOVERNANCE_OBSERVATION_CATEGORIES,
  GOVERNANCE_OBSERVATION_DEFAULT_PAGE_SIZE,
  type GovernanceCommandExecution,
  type GovernanceCommandReceipt,
  type GovernanceEventStore,
  type GovernanceObservationCategory,
  type StoredGovernanceObservation,
} from './event-store.js';
import {
  evaluateGovernanceEvidenceCandidateObservation,
  GOVERNANCE_EVIDENCE_CANDIDATE_DEFAULT_PAGE_SIZE,
  type GovernanceEvidenceCandidateLedgerEntry,
} from './evidence-candidate.js';
import { decodeGovernanceServiceRequest } from './protocol-decoder.js';
import {
  GOVERNANCE_SERVICE_PROTOCOL_VERSION,
  type GovernanceServiceCapability,
  type GovernanceServiceClientContext,
  type GovernanceServiceRequest,
} from './service-protocol.js';
import type {
  GovernanceCommand,
  GovernanceDecisionContext,
  GovernanceEvent,
  TaskAggregate,
} from './task-aggregate.js';
import type { RecordWorkspaceSnapshotResult } from './workspace-snapshot-fence.js';

export type {
  GovernanceServiceCapability,
  GovernanceServiceClientContext,
  GovernanceServiceRequest,
} from './service-protocol.js';
export {
  GOVERNANCE_SERVICE_CAPABILITIES,
  GOVERNANCE_SERVICE_PROTOCOL_VERSION,
} from './service-protocol.js';

type GovernanceServiceResult =
  | {
      readonly type: 'health';
      readonly projectId: string;
      readonly protocolVersion: typeof GOVERNANCE_SERVICE_PROTOCOL_VERSION;
      readonly status: 'ready';
    }
  | { readonly type: 'task'; readonly task: TaskAggregate | null }
  | { readonly type: 'events'; readonly events: readonly GovernanceEvent[] }
  | { readonly type: 'receipt'; readonly receipt: GovernanceCommandReceipt | null }
  | {
      readonly type: 'observations';
      readonly observations: readonly StoredGovernanceObservation[];
      readonly nextAfterSequence: number | null;
    }
  | {
      readonly type: 'evidence_candidates';
      readonly taskId: string;
      readonly candidates: readonly GovernanceEvidenceCandidateLedgerEntry[];
      readonly nextAfterSequence: number | null;
    }
  | { readonly type: 'command_result'; readonly execution: GovernanceCommandExecution }
  | {
      readonly type: 'observation_result';
      readonly result: AppendGovernanceObservationResult;
    }
  | {
      readonly type: 'workspace_snapshot_recorded';
      readonly result: RecordWorkspaceSnapshotResult;
    }
  | {
      readonly type: 'capability_grant_issued';
      readonly grant: GovernanceCapabilityGrant;
      readonly credential: GovernanceServiceCredential;
    }
  | {
      readonly type: 'runtime_attachment_claimed';
      readonly control: {
        readonly grant: GovernanceCapabilityGrant;
        readonly credential: GovernanceServiceCredential;
      };
      readonly model: {
        readonly grant: GovernanceCapabilityGrant;
        readonly credential: GovernanceServiceCredential;
      };
    }
  | {
      readonly type: 'runtime_attachment_released';
      readonly controlGrantId: string;
      readonly modelGrantId: string;
    }
  | {
      readonly type: 'own_capability_grant';
      readonly grant: GovernanceCapabilityGrant;
    }
  | {
      readonly type: 'daemon_status';
      readonly projectId: string;
      readonly pid: number;
      readonly instanceId: string;
      readonly startedAt: string;
      readonly attachmentBroker?: GovernanceAttachmentBrokerControllerSnapshot | undefined;
    }
  | {
      readonly type: 'daemon_shutdown_accepted';
      readonly instanceId: string;
      readonly requestedBy: string;
      readonly reason: string;
    }
  | {
      readonly type: 'capability_grants';
      readonly grants: readonly GovernanceCapabilityGrant[];
      readonly nextCursor?: string | undefined;
    }
  | {
      readonly type: 'capability_grant_revoked';
      readonly grantId: string;
      readonly revoked: boolean;
    }
  | {
      readonly type: 'capability_grant_rotated';
      readonly previousGrantId: string;
      readonly grant: GovernanceCapabilityGrant;
      readonly credential: GovernanceServiceCredential;
    };

type GovernanceServiceErrorCode =
  | 'unsupported_protocol'
  | 'invalid_request'
  | 'authentication_failed'
  | 'permission_denied'
  | 'identity_mismatch'
  | 'project_mismatch'
  | 'store_failure'
  | 'request_in_progress';

export type GovernanceServiceResponse =
  | {
      readonly ok: true;
      readonly requestId: string;
      readonly result: GovernanceServiceResult;
    }
  | {
      readonly ok: false;
      readonly requestId: string;
      readonly error: {
        readonly code: GovernanceServiceErrorCode;
        readonly message: string;
        readonly details?:
          | readonly { readonly code: string; readonly path: string; readonly message: string }[]
          | undefined;
      };
    };

const REQUIRED_CAPABILITY: Readonly<
  Partial<Record<GovernanceServiceRequest['type'], GovernanceServiceCapability>>
> = {
  read_task: 'task_read',
  read_events: 'task_read',
  read_receipt: 'audit_read',
  read_observations: 'task_read',
  read_evidence_candidates: 'task_read',
  read_audit_observations: 'audit_read',
  submit_command: 'command_submit',
  record_observation: 'shadow_observe',
  record_workspace_snapshot: 'workspace_snapshot_record',
  issue_capability_grant: 'capability_admin',
  claim_runtime_attachment: 'runtime_attach',
  release_runtime_attachment: 'runtime_attachment_release',
  list_capability_grants: 'capability_admin',
  revoke_capability_grant: 'capability_admin',
  rotate_capability_grant: 'capability_admin',
  read_daemon_status: 'daemon_status_read',
  request_daemon_shutdown: 'daemon_control',
};

function fail(
  requestId: string,
  code: GovernanceServiceErrorCode,
  message: string,
  details?: readonly { readonly code: string; readonly path: string; readonly message: string }[],
): GovernanceServiceResponse {
  return {
    ok: false,
    requestId,
    error: { code, message, ...(details ? { details } : {}) },
  };
}

function reservedAuditCategory(category: string): boolean {
  return category.startsWith('capability_grant_') || category.startsWith('daemon_');
}

/**
 * The audit/non-audit split, resolved once against the closed category enum.
 * Both read endpoints used to fetch every observation a project had and then
 * apply `reservedAuditCategory` in JavaScript, discarding most of what they had
 * just parsed; passing the exact set to the store keeps that work in SQL.
 */
const AUDIT_OBSERVATION_CATEGORIES = Object.freeze(
  GOVERNANCE_OBSERVATION_CATEGORIES.filter((category) => reservedAuditCategory(category)),
);
const TASK_OBSERVATION_CATEGORIES = Object.freeze(
  GOVERNANCE_OBSERVATION_CATEGORIES.filter((category) => !reservedAuditCategory(category)),
);

export type GovernanceDecisionContextProvider = (
  command: GovernanceCommand,
) => GovernanceDecisionContext;

export class GovernanceProjectService {
  constructor(
    readonly projectId: string,
    private readonly store: GovernanceEventStore,
    /** Trusted policy adapter owned by the future daemon, never selected by request payloads. */
    private readonly resolveDecisionContext: GovernanceDecisionContextProvider = () => ({}),
  ) {}

  handleUnknown(input: unknown, client: GovernanceServiceClientContext): GovernanceServiceResponse {
    const decoded = decodeGovernanceServiceRequest(input);
    if (!decoded.decoded) {
      const requestId =
        input &&
        typeof input === 'object' &&
        'requestId' in input &&
        typeof input.requestId === 'string'
          ? input.requestId
          : 'unknown';
      return fail(
        requestId,
        'invalid_request',
        'Governance service request failed strict protocol decoding.',
        decoded.issues,
      );
    }
    return this.handle(decoded.request, client);
  }

  handle(
    request: GovernanceServiceRequest,
    client: GovernanceServiceClientContext,
  ): GovernanceServiceResponse {
    if (request.protocolVersion !== GOVERNANCE_SERVICE_PROTOCOL_VERSION) {
      return fail(
        request.requestId,
        'unsupported_protocol',
        `Protocol version ${request.protocolVersion} is not supported.`,
      );
    }

    const requiredCapability = REQUIRED_CAPABILITY[request.type];
    if (requiredCapability && !client.capabilities.has(requiredCapability)) {
      return fail(
        request.requestId,
        'permission_denied',
        `Client ${client.clientId} lacks capability ${requiredCapability}.`,
      );
    }
    if (request.type === 'record_observation') {
      if (reservedAuditCategory(request.observation.category)) {
        return fail(
          request.requestId,
          'permission_denied',
          'Governance lifecycle observations are reserved for the project server.',
        );
      }
      if (request.observation.source !== client.clientId) {
        return fail(
          request.requestId,
          'identity_mismatch',
          'Observation source must match the authenticated client identity.',
        );
      }
    }

    try {
      return this.handleAuthorized(request);
    } catch (error) {
      return fail(
        request.requestId,
        'store_failure',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  close(): void {
    this.store.close();
  }

  private handleAuthorized(request: GovernanceServiceRequest): GovernanceServiceResponse {
    const requestId = request.requestId;
    switch (request.type) {
      case 'health':
        return {
          ok: true,
          requestId,
          result: {
            type: 'health',
            projectId: this.projectId,
            protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
            status: 'ready',
          },
        };
      case 'read_task': {
        const task = this.store.readTask(request.taskId);
        if (task && task.projectId !== this.projectId) {
          return fail(
            requestId,
            'project_mismatch',
            `Task ${request.taskId} does not belong to project ${this.projectId}.`,
          );
        }
        return {
          ok: true,
          requestId,
          result: { type: 'task', task },
        };
      }
      case 'read_events': {
        const task = this.store.readTask(request.taskId);
        if (task && task.projectId !== this.projectId) {
          return fail(
            requestId,
            'project_mismatch',
            `Task ${request.taskId} does not belong to project ${this.projectId}.`,
          );
        }
        return {
          ok: true,
          requestId,
          result: { type: 'events', events: this.store.readEvents(request.taskId) },
        };
      }
      case 'read_receipt': {
        const receipt = this.store.readReceipt(request.commandId);
        if (receipt && !this.commandBelongsToProject(receipt.command)) {
          return fail(
            requestId,
            'project_mismatch',
            `Command ${request.commandId} does not belong to project ${this.projectId}.`,
          );
        }
        return {
          ok: true,
          requestId,
          result: { type: 'receipt', receipt },
        };
      }
      case 'read_observations':
        return this.observationPage(
          requestId,
          TASK_OBSERVATION_CATEGORIES,
          request.taskId,
          request.afterSequence,
          request.limit,
        );
      case 'read_evidence_candidates': {
        const limit = request.limit ?? GOVERNANCE_EVIDENCE_CANDIDATE_DEFAULT_PAGE_SIZE;
        const rows = this.store.readEvidenceCandidateObservations(this.projectId, request.taskId, {
          afterSequence: request.afterSequence ?? 0,
          limit: limit + 1,
        });
        const page = rows.slice(0, limit);
        return {
          ok: true,
          requestId,
          result: {
            type: 'evidence_candidates',
            taskId: request.taskId,
            candidates: Object.freeze(
              page.map((observation) =>
                evaluateGovernanceEvidenceCandidateObservation(observation),
              ),
            ),
            nextAfterSequence:
              rows.length > limit && page.length > 0 ? (page.at(-1)?.sequence ?? null) : null,
          },
        };
      }
      case 'read_audit_observations':
        return this.observationPage(
          requestId,
          AUDIT_OBSERVATION_CATEGORIES,
          undefined,
          request.afterSequence,
          request.limit,
        );
      case 'submit_command': {
        if (!this.commandBelongsToProject(request.command)) {
          return fail(
            requestId,
            'project_mismatch',
            `Command task does not belong to project ${this.projectId}.`,
          );
        }
        return {
          ok: true,
          requestId,
          result: {
            type: 'command_result',
            execution: this.store.execute(
              request.command,
              this.resolveDecisionContext(request.command),
            ),
          },
        };
      }
      case 'record_observation':
        if (request.observation.projectId !== this.projectId) {
          return fail(
            requestId,
            'project_mismatch',
            `Observation belongs to project ${request.observation.projectId}, not ${this.projectId}.`,
          );
        }
        return {
          ok: true,
          requestId,
          result: {
            type: 'observation_result',
            result: this.store.appendObservation(request.observation),
          },
        };
      case 'record_workspace_snapshot':
        return {
          ok: true,
          requestId,
          result: {
            type: 'workspace_snapshot_recorded',
            result: this.store.recordWorkspaceSnapshot(this.projectId, request.manifestHash),
          },
        };
      case 'issue_capability_grant':
      case 'claim_runtime_attachment':
      case 'release_runtime_attachment':
      case 'read_own_capability_grant':
      case 'read_daemon_status':
      case 'request_daemon_shutdown':
      case 'list_capability_grants':
      case 'revoke_capability_grant':
      case 'rotate_capability_grant':
        return fail(
          requestId,
          'permission_denied',
          'Capability administration is available only through the authenticated facade.',
        );
    }
  }

  /**
   * Shared body for both observation reads. Fetches one row past the page so
   * the presence of a further page is known without a second query — the same
   * convention `read_evidence_candidates` uses.
   */
  private observationPage(
    requestId: string,
    categories: readonly GovernanceObservationCategory[],
    taskId: string | undefined,
    afterSequence: number | undefined,
    limit: number | undefined,
  ): GovernanceServiceResponse {
    const pageSize = limit ?? GOVERNANCE_OBSERVATION_DEFAULT_PAGE_SIZE;
    const rows = this.store.readObservationsPage({
      projectId: this.projectId,
      ...(taskId === undefined ? {} : { taskId }),
      categories,
      afterSequence: afterSequence ?? 0,
      limit: pageSize + 1,
    });
    const page = rows.slice(0, pageSize);
    return {
      ok: true,
      requestId,
      result: {
        type: 'observations',
        observations: page,
        nextAfterSequence:
          rows.length > pageSize && page.length > 0 ? (page.at(-1)?.sequence ?? null) : null,
      },
    };
  }

  private commandBelongsToProject(command: GovernanceCommand): boolean {
    if (command.type === 'create_task') {
      return command.projectId === this.projectId && command.contract.projectId === this.projectId;
    }
    const task = this.store.readTask(command.taskId);
    return task === null || task.projectId === this.projectId;
  }
}
