import type {
  GovernanceCapabilityGrantRegistry,
  GovernanceServiceCredential,
} from './capability-grant.js';
import type { GovernanceDaemonControlPort } from './daemon-control.js';
import { GovernanceManagementReceiptCache } from './management-receipt-cache.js';
import type { GovernanceProjectService, GovernanceServiceResponse } from './project-service.js';
import { decodeGovernanceServiceRequest } from './protocol-decoder.js';

const GOVERNANCE_RUNTIME_ATTACHMENT_MAX_TTL_MS = 30 * 60 * 1_000;

function requestIdFromUnknown(input: unknown): string {
  return input &&
    typeof input === 'object' &&
    'requestId' in input &&
    typeof input.requestId === 'string'
    ? input.requestId
    : 'unknown';
}

function isManagementRequestType(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const type = (input as { type?: unknown }).type;
  return (
    type === 'issue_capability_grant' ||
    type === 'claim_runtime_attachment' ||
    type === 'release_runtime_attachment' ||
    type === 'list_capability_grants' ||
    type === 'revoke_capability_grant' ||
    type === 'rotate_capability_grant'
  );
}

function permissionDenied(requestId: string, message: string): GovernanceServiceResponse {
  return { ok: false, requestId, error: { code: 'permission_denied', message } };
}

function invalidManagementRequest(requestId: string): GovernanceServiceResponse {
  return {
    ok: false,
    requestId,
    error: { code: 'invalid_request', message: 'Capability grant request was rejected.' },
  };
}

function receiptConflict(requestId: string): GovernanceServiceResponse {
  return {
    ok: false,
    requestId,
    error: {
      code: 'invalid_request',
      message: 'Management requestId was already used with a different payload.',
    },
  };
}

function receiptInProgress(requestId: string): GovernanceServiceResponse {
  return {
    ok: false,
    requestId,
    error: {
      code: 'request_in_progress',
      message: 'Management request is already being processed; retry after it completes.',
    },
  };
}

function receiptCapacityExceeded(requestId: string): GovernanceServiceResponse {
  return {
    ok: false,
    requestId,
    error: {
      code: 'store_failure',
      message: 'Management retry receipt capacity is temporarily unavailable.',
    },
  };
}

function daemonControlFailure(
  requestId: string,
  code: 'store_failure' | 'identity_mismatch',
  message: string,
): GovernanceServiceResponse {
  return { ok: false, requestId, error: { code, message } };
}

/** External facade for a future IPC transport. Raw capability sets never cross this boundary. */
export class AuthenticatedGovernanceProjectService {
  readonly projectId: string;
  readonly #attachmentModelGrantByControlGrant = new Map<string, string>();

  constructor(
    private readonly service: GovernanceProjectService,
    private readonly grants: GovernanceCapabilityGrantRegistry,
    private readonly receipts: GovernanceManagementReceiptCache = new GovernanceManagementReceiptCache(),
    private readonly daemonControl?: GovernanceDaemonControlPort | undefined,
  ) {
    if (service.projectId !== grants.projectId) {
      throw new Error('Governance service and capability registry projects must match.');
    }
    this.projectId = service.projectId;
  }

  handleUnknown(
    input: unknown,
    credential: GovernanceServiceCredential,
  ): GovernanceServiceResponse {
    // Receipts protect management request types. A recycled requestId
    // across a non-management request type must not be masked by a stored receipt
    // that belongs to a different (management) request.
    const receiptScoped = isManagementRequestType(input)
      ? this.receipts.lookup(input, credential)
      : { kind: 'miss' as const };
    const authentication = this.grants.authenticate(credential);
    if (!authentication.authenticated) {
      if (receiptScoped.kind === 'replay' && receiptScoped.allowAfterRotation) {
        return receiptScoped.response;
      }
      return {
        ok: false,
        requestId: requestIdFromUnknown(input),
        error: {
          code: 'authentication_failed',
          message: 'Governance service authentication failed.',
        },
      };
    }
    if (receiptScoped.kind === 'replay') return receiptScoped.response;
    if (receiptScoped.kind === 'in_progress') return receiptInProgress(requestIdFromUnknown(input));
    if (receiptScoped.kind === 'conflict') return receiptConflict(requestIdFromUnknown(input));
    const decoded = decodeGovernanceServiceRequest(input);
    if (!decoded.decoded) return this.service.handleUnknown(input, authentication.client);
    const request = decoded.request;
    if (
      request.type !== 'issue_capability_grant' &&
      request.type !== 'claim_runtime_attachment' &&
      request.type !== 'release_runtime_attachment' &&
      request.type !== 'read_own_capability_grant' &&
      request.type !== 'read_daemon_status' &&
      request.type !== 'request_daemon_shutdown' &&
      request.type !== 'list_capability_grants' &&
      request.type !== 'revoke_capability_grant' &&
      request.type !== 'rotate_capability_grant'
    ) {
      return this.service.handle(request, authentication.client);
    }
    if (request.type === 'read_own_capability_grant') {
      return {
        ok: true,
        requestId: request.requestId,
        result: { type: 'own_capability_grant', grant: authentication.grant },
      };
    }
    if (request.type === 'claim_runtime_attachment') {
      if (!authentication.client.capabilities.has('runtime_attach')) {
        return permissionDenied(
          request.requestId,
          `Client ${authentication.client.clientId} lacks capability runtime_attach.`,
        );
      }
      if (
        request.controlClientId === authentication.client.clientId ||
        request.modelClientId === authentication.client.clientId
      ) {
        return invalidManagementRequest(request.requestId);
      }
      const remainingTtlMs = this.grants.remainingTtlMs(authentication.grant.grantId);
      if (remainingTtlMs === null) return invalidManagementRequest(request.requestId);
      const ttlMs = Math.min(
        request.ttlMs,
        remainingTtlMs,
        GOVERNANCE_RUNTIME_ATTACHMENT_MAX_TTL_MS,
      );
      const reservation = this.receipts.reserve({ input: request, wireInput: input, credential });
      if (!reservation) return receiptCapacityExceeded(request.requestId);
      let controlGrantId: string | undefined;
      let modelGrantId: string | undefined;
      try {
        const control = this.grants.issue({
          clientId: request.controlClientId,
          issuedBy: authentication.client.clientId,
          capabilities: [
            'workspace_snapshot_record',
            'runtime_attachment_release',
            'daemon_status_read',
          ],
          ttlMs,
        });
        controlGrantId = control.grant.grantId;
        const model = this.grants.issue({
          clientId: request.modelClientId,
          issuedBy: authentication.client.clientId,
          capabilities: request.modelCapabilities,
          ttlMs,
        });
        modelGrantId = model.grant.grantId;
        this.#attachmentModelGrantByControlGrant.set(control.grant.grantId, model.grant.grantId);
        const response: GovernanceServiceResponse = {
          ok: true,
          requestId: request.requestId,
          result: {
            type: 'runtime_attachment_claimed',
            control: {
              grant: control.grant,
              credential: {
                token: control.token,
                projectId: this.projectId,
                clientId: request.controlClientId,
              },
            },
            model: {
              grant: model.grant,
              credential: {
                token: model.token,
                projectId: this.projectId,
                clientId: request.modelClientId,
              },
            },
          },
        };
        this.receipts.commit(reservation, response);
        return response;
      } catch {
        if (modelGrantId) {
          try {
            this.grants.revoke(
              modelGrantId,
              'runtime attachment claim rolled back',
              authentication.client.clientId,
            );
          } catch {
            // Continue with control-grant compensation below.
          }
        }
        if (controlGrantId) {
          try {
            this.grants.revoke(
              controlGrantId,
              'runtime attachment claim rolled back',
              authentication.client.clientId,
            );
          } catch {
            // The original request must still fail closed. Audit-sink recovery is
            // surfaced by the registry ledger and handled by daemon supervision.
          }
          this.#attachmentModelGrantByControlGrant.delete(controlGrantId);
        }
        this.receipts.release(reservation);
        return invalidManagementRequest(request.requestId);
      }
    }
    if (request.type === 'release_runtime_attachment') {
      if (!authentication.client.capabilities.has('runtime_attachment_release')) {
        return permissionDenied(
          request.requestId,
          `Client ${authentication.client.clientId} lacks capability runtime_attachment_release.`,
        );
      }
      const modelGrantId = this.#attachmentModelGrantByControlGrant.get(
        authentication.grant.grantId,
      );
      if (!modelGrantId) return invalidManagementRequest(request.requestId);
      const reservation = this.receipts.reserve({ input: request, wireInput: input, credential });
      if (!reservation) return receiptCapacityExceeded(request.requestId);
      try {
        this.grants.revoke(
          modelGrantId,
          'runtime attachment released',
          authentication.client.clientId,
        );
        this.grants.revoke(
          authentication.grant.grantId,
          'runtime attachment released',
          authentication.client.clientId,
        );
        this.#attachmentModelGrantByControlGrant.delete(authentication.grant.grantId);
        const response: GovernanceServiceResponse = {
          ok: true,
          requestId: request.requestId,
          result: {
            type: 'runtime_attachment_released',
            controlGrantId: authentication.grant.grantId,
            modelGrantId,
          },
        };
        this.receipts.commit(reservation, response, true);
        return response;
      } catch {
        this.receipts.release(reservation);
        return invalidManagementRequest(request.requestId);
      }
    }
    if (request.type === 'read_daemon_status' || request.type === 'request_daemon_shutdown') {
      const requiredCapability =
        request.type === 'read_daemon_status' ? 'daemon_status_read' : 'daemon_control';
      const authorized =
        authentication.client.capabilities.has(requiredCapability) ||
        (request.type === 'read_daemon_status' &&
          authentication.client.capabilities.has('daemon_control'));
      if (!authorized) {
        return permissionDenied(
          request.requestId,
          `Client ${authentication.client.clientId} lacks capability ${requiredCapability}.`,
        );
      }
      if (!this.daemonControl) {
        return daemonControlFailure(
          request.requestId,
          'store_failure',
          'Governance daemon control is unavailable in this server mode.',
        );
      }
      let status: ReturnType<GovernanceDaemonControlPort['status']>;
      try {
        status = this.daemonControl.status();
      } catch {
        return daemonControlFailure(
          request.requestId,
          'store_failure',
          'Governance daemon status could not be read.',
        );
      }
      if (request.type === 'read_daemon_status') {
        return {
          ok: true,
          requestId: request.requestId,
          result: { type: 'daemon_status', ...status },
        };
      }
      if (request.expectedInstanceId !== status.instanceId) {
        return daemonControlFailure(
          request.requestId,
          'identity_mismatch',
          'Governance daemon instance identity does not match.',
        );
      }
      return {
        ok: true,
        requestId: request.requestId,
        result: {
          type: 'daemon_shutdown_accepted',
          instanceId: status.instanceId,
          requestedBy: authentication.client.clientId,
          reason: request.reason ?? 'graceful shutdown requested by control plane',
        },
      };
    }
    if (!authentication.client.capabilities.has('capability_admin')) {
      return permissionDenied(
        request.requestId,
        `Client ${authentication.client.clientId} lacks capability capability_admin.`,
      );
    }
    if (request.type === 'issue_capability_grant') {
      if (
        request.capabilities.includes('capability_admin') ||
        request.capabilities.includes('daemon_control') ||
        request.capabilities.includes('daemon_status_read') ||
        request.capabilities.includes('runtime_attach') ||
        request.capabilities.includes('runtime_attachment_release')
      ) {
        return permissionDenied(
          request.requestId,
          'Control-plane capabilities cannot be delegated through the service protocol.',
        );
      }
      const reservation = this.receipts.reserve({ input: request, wireInput: input, credential });
      if (!reservation) return receiptCapacityExceeded(request.requestId);
      try {
        const issued = this.grants.issue({
          clientId: request.clientId,
          issuedBy: authentication.client.clientId,
          capabilities: request.capabilities,
          ttlMs: request.ttlMs,
        });
        const response: GovernanceServiceResponse = {
          ok: true,
          requestId: request.requestId,
          result: {
            type: 'capability_grant_issued',
            grant: issued.grant,
            credential: {
              token: issued.token,
              projectId: this.projectId,
              clientId: request.clientId,
            },
          },
        };
        this.receipts.commit(reservation, response);
        return response;
      } catch {
        this.receipts.release(reservation);
        return invalidManagementRequest(request.requestId);
      }
    }
    if (request.type === 'list_capability_grants') {
      this.grants.sweepExpired();
      const grants = this.grants.listGrants();
      let start = 0;
      if (request.cursor) {
        const cursorIndex = grants.findIndex((grant) => grant.grantId === request.cursor);
        if (cursorIndex < 0) return invalidManagementRequest(request.requestId);
        start = cursorIndex + 1;
      }
      const limit = request.limit ?? 50;
      const page = Object.freeze(grants.slice(start, start + limit));
      const last = page.at(-1);
      const nextCursor = start + page.length < grants.length ? last?.grantId : undefined;
      return {
        ok: true,
        requestId: request.requestId,
        result: {
          type: 'capability_grants',
          grants: page,
          ...(nextCursor ? { nextCursor } : {}),
        },
      };
    }
    if (request.type === 'rotate_capability_grant') {
      const target = this.grants.getGrant(request.grantId);
      if (
        target?.capabilities.includes('capability_admin') &&
        authentication.grant.grantId !== target.grantId
      ) {
        return permissionDenied(
          request.requestId,
          'An administrator can rotate only its own capability_admin grant.',
        );
      }
      const reservation = this.receipts.reserve({ input: request, wireInput: input, credential });
      if (!reservation) return receiptCapacityExceeded(request.requestId);
      try {
        const rotatesCurrentGrant = authentication.grant.grantId === request.grantId;
        const rotated = this.grants.rotate(request.grantId, {
          rotatedBy: authentication.client.clientId,
          ttlMs: request.ttlMs,
          ...(request.reason ? { reason: request.reason } : {}),
        });
        const response: GovernanceServiceResponse = {
          ok: true,
          requestId: request.requestId,
          result: {
            type: 'capability_grant_rotated',
            previousGrantId: request.grantId,
            grant: rotated.grant,
            credential: {
              token: rotated.token,
              projectId: this.projectId,
              clientId: rotated.grant.clientId,
            },
          },
        };
        this.receipts.commit(reservation, response, rotatesCurrentGrant);
        return response;
      } catch {
        this.receipts.release(reservation);
        return invalidManagementRequest(request.requestId);
      }
    }
    const reservation = this.receipts.reserve({ input: request, wireInput: input, credential });
    let revoked: boolean;
    try {
      revoked = this.grants.revoke(
        request.grantId,
        (request.reason ?? `revoked by ${authentication.client.clientId}`).slice(0, 512),
        authentication.client.clientId,
      );
    } catch {
      if (reservation) this.receipts.release(reservation);
      return invalidManagementRequest(request.requestId);
    }
    const response: GovernanceServiceResponse = {
      ok: true,
      requestId: request.requestId,
      result: {
        type: 'capability_grant_revoked',
        grantId: request.grantId,
        revoked,
      },
    };
    // Revoke is the security-critical operation that must never be blocked by a
    // saturated retry-receipt cache. If reservation failed, we still perform the
    // revoke and skip caching its receipt.
    if (reservation && revoked) this.receipts.commit(reservation, response);
    else if (reservation) this.receipts.release(reservation);
    return response;
  }

  close(): void {
    this.#attachmentModelGrantByControlGrant.clear();
    this.receipts.clear();
    this.service.close();
  }
}
