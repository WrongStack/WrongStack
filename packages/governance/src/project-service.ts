import type { GovernanceCapabilityGrant, GovernanceServiceCredential } from './capability-grant.js';
import type {
  AppendGovernanceObservationResult,
  GovernanceCommandExecution,
  GovernanceCommandReceipt,
  GovernanceEventStore,
  StoredGovernanceObservation,
} from './event-store.js';
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

export type {
  GovernanceServiceCapability,
  GovernanceServiceClientContext,
  GovernanceServiceRequest,
} from './service-protocol.js';
export {
  GOVERNANCE_SERVICE_CAPABILITIES,
  GOVERNANCE_SERVICE_PROTOCOL_VERSION,
} from './service-protocol.js';

export type GovernanceServiceResult =
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
    }
  | { readonly type: 'command_result'; readonly execution: GovernanceCommandExecution }
  | {
      readonly type: 'observation_result';
      readonly result: AppendGovernanceObservationResult;
    }
  | {
      readonly type: 'capability_grant_issued';
      readonly grant: GovernanceCapabilityGrant;
      readonly credential: GovernanceServiceCredential;
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
    };

export type GovernanceServiceErrorCode =
  | 'unsupported_protocol'
  | 'invalid_request'
  | 'authentication_failed'
  | 'permission_denied'
  | 'identity_mismatch'
  | 'project_mismatch'
  | 'store_failure';

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
  read_audit_observations: 'audit_read',
  submit_command: 'command_submit',
  record_observation: 'shadow_observe',
  issue_capability_grant: 'capability_admin',
  list_capability_grants: 'capability_admin',
  revoke_capability_grant: 'capability_admin',
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
      if (request.observation.category.startsWith('capability_grant_')) {
        return fail(
          request.requestId,
          'permission_denied',
          'Capability grant lifecycle observations are reserved for the project server.',
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
        return {
          ok: true,
          requestId,
          result: {
            type: 'observations',
            observations: this.store
              .readObservations(this.projectId, request.taskId)
              .filter((observation) => !observation.category.startsWith('capability_grant_')),
          },
        };
      case 'read_audit_observations':
        return {
          ok: true,
          requestId,
          result: {
            type: 'observations',
            observations: this.store
              .readObservations(this.projectId)
              .filter((observation) => observation.category.startsWith('capability_grant_')),
          },
        };
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
      case 'issue_capability_grant':
      case 'list_capability_grants':
      case 'revoke_capability_grant':
        return fail(
          requestId,
          'permission_denied',
          'Capability administration is available only through the authenticated facade.',
        );
    }
  }

  private commandBelongsToProject(command: GovernanceCommand): boolean {
    if (command.type === 'create_task') {
      return command.projectId === this.projectId && command.contract.projectId === this.projectId;
    }
    const task = this.store.readTask(command.taskId);
    return task === null || task.projectId === this.projectId;
  }
}
