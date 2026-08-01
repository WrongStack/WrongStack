import type {
  GovernanceCapabilityGrantRegistry,
  GovernanceServiceCredential,
} from './capability-grant.js';
import type { GovernanceProjectService, GovernanceServiceResponse } from './project-service.js';
import { decodeGovernanceServiceRequest } from './protocol-decoder.js';

function requestIdFromUnknown(input: unknown): string {
  return input &&
    typeof input === 'object' &&
    'requestId' in input &&
    typeof input.requestId === 'string'
    ? input.requestId
    : 'unknown';
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

/** External facade for a future IPC transport. Raw capability sets never cross this boundary. */
export class AuthenticatedGovernanceProjectService {
  readonly projectId: string;

  constructor(
    private readonly service: GovernanceProjectService,
    private readonly grants: GovernanceCapabilityGrantRegistry,
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
    const authentication = this.grants.authenticate(credential);
    if (!authentication.authenticated) {
      return {
        ok: false,
        requestId: requestIdFromUnknown(input),
        error: {
          code: 'authentication_failed',
          message: 'Governance service authentication failed.',
        },
      };
    }
    const decoded = decodeGovernanceServiceRequest(input);
    if (!decoded.decoded) return this.service.handleUnknown(input, authentication.client);
    const request = decoded.request;
    if (
      request.type !== 'issue_capability_grant' &&
      request.type !== 'list_capability_grants' &&
      request.type !== 'revoke_capability_grant'
    ) {
      return this.service.handle(request, authentication.client);
    }
    if (!authentication.client.capabilities.has('capability_admin')) {
      return permissionDenied(
        request.requestId,
        `Client ${authentication.client.clientId} lacks capability capability_admin.`,
      );
    }
    if (request.type === 'issue_capability_grant') {
      if (request.capabilities.includes('capability_admin')) {
        return permissionDenied(
          request.requestId,
          'capability_admin cannot be delegated through the service protocol.',
        );
      }
      try {
        const issued = this.grants.issue({
          clientId: request.clientId,
          issuedBy: authentication.client.clientId,
          capabilities: request.capabilities,
          ttlMs: request.ttlMs,
        });
        return {
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
      } catch {
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
    return {
      ok: true,
      requestId: request.requestId,
      result: {
        type: 'capability_grant_revoked',
        grantId: request.grantId,
        revoked: this.grants.revoke(
          request.grantId,
          request.reason ?? `revoked by ${authentication.client.clientId}`,
          authentication.client.clientId,
        ),
      },
    };
  }

  close(): void {
    this.service.close();
  }
}
