import { randomUUID } from 'node:crypto';

import type { GovernanceServiceCredential } from './capability-grant.js';
import {
  GovernanceCredentialLeaseController,
  type GovernanceCredentialLeaseSnapshot,
} from './credential-lease-controller.js';
import type { GovernanceProjectDaemonLaunch } from './daemon-launcher.js';
import type { GovernanceDaemonMetadata } from './daemon-metadata.js';
import {
  connectGovernanceProjectClient,
  type GovernanceProjectClientOptions,
} from './project-client.js';
import type { GovernanceServiceResponse } from './project-service.js';
import { GOVERNANCE_SERVICE_PROTOCOL_VERSION } from './service-protocol.js';

export interface GovernanceAdminSessionLeaseOptions extends GovernanceProjectClientOptions {
  readonly rotationTtlMs?: number | undefined;
  readonly renewBeforeMs?: number | undefined;
  readonly retryDelayMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly startLease?: boolean | undefined;
}

export interface ConnectGovernanceAdminSessionOptions extends GovernanceAdminSessionLeaseOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly grantId: string;
  readonly credential: GovernanceServiceCredential;
}

type GovernanceAdminSessionConnectionFailureCode =
  | 'not_running'
  | 'endpoint_invalid'
  | 'project_mismatch'
  | 'credential_mismatch'
  | 'authentication_failed'
  | 'service_rejected'
  | 'admin_required'
  | 'grant_mismatch';

export type ConnectGovernanceAdminSessionResult =
  | { readonly connected: true; readonly session: GovernanceAdminSession }
  | {
      readonly connected: false;
      readonly code: GovernanceAdminSessionConnectionFailureCode;
      readonly message: string;
    };

export interface GovernanceAdminSessionSnapshot {
  readonly mode: 'attached' | 'launched';
  readonly daemon: {
    readonly projectRoot: string;
    readonly projectId: string;
    readonly pid: number;
    readonly instanceId: string;
    readonly startedAt: string;
  };
  readonly lease: GovernanceCredentialLeaseSnapshot;
}

interface ExpectedLaunchIdentity {
  readonly pid: number;
  readonly instanceId: string;
  readonly startedAt: string;
  readonly expiresAt: string;
}

const GOVERNANCE_ADMIN_SESSION_CONSTRUCTION = Symbol('governance-admin-session-construction');

export class GovernanceAdminSession {
  constructor(
    construction: typeof GOVERNANCE_ADMIN_SESSION_CONSTRUCTION,
    readonly mode: 'attached' | 'launched',
    private readonly metadata: GovernanceDaemonMetadata,
    private readonly lease: GovernanceCredentialLeaseController,
  ) {
    if (construction !== GOVERNANCE_ADMIN_SESSION_CONSTRUCTION) {
      throw new Error('Governance admin sessions must be created through a verified connector.');
    }
  }

  request(input: unknown): Promise<GovernanceServiceResponse> {
    return this.lease.request(input);
  }

  readDaemonStatus(): Promise<GovernanceServiceResponse> {
    return this.lease.request({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: `daemon-status-${randomUUID()}`,
      type: 'read_daemon_status',
    });
  }

  async shutdownDaemon(
    reason = 'admin session requested graceful shutdown',
  ): Promise<GovernanceServiceResponse> {
    const response = await this.lease.request({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: `daemon-shutdown-${randomUUID()}`,
      type: 'request_daemon_shutdown',
      expectedInstanceId: this.metadata.instanceId,
      reason,
    });
    if (response.ok && response.result.type === 'daemon_shutdown_accepted') this.lease.stop();
    return response;
  }

  rotateNow(): Promise<GovernanceCredentialLeaseSnapshot> {
    return this.lease.rotateNow();
  }

  stop(): GovernanceAdminSessionSnapshot {
    this.lease.stop();
    return this.snapshot();
  }

  snapshot(): GovernanceAdminSessionSnapshot {
    return Object.freeze({
      mode: this.mode,
      daemon: Object.freeze({
        projectRoot: this.metadata.projectRoot,
        projectId: this.metadata.projectId,
        pid: this.metadata.pid,
        instanceId: this.metadata.instanceId,
        startedAt: this.metadata.startedAt,
      }),
      lease: this.lease.snapshot(),
    });
  }
}

function failure(
  code: GovernanceAdminSessionConnectionFailureCode,
  message: string,
): ConnectGovernanceAdminSessionResult {
  return { connected: false, code, message };
}

async function connectAdminSession(
  options: ConnectGovernanceAdminSessionOptions,
  mode: 'attached' | 'launched',
  expectedLaunch?: ExpectedLaunchIdentity,
): Promise<ConnectGovernanceAdminSessionResult> {
  const connection = await connectGovernanceProjectClient({
    projectRoot: options.projectRoot,
    projectId: options.projectId,
    credential: options.credential,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  if (!connection.connected) return connection;
  if (
    expectedLaunch &&
    (connection.metadata.pid !== expectedLaunch.pid ||
      connection.metadata.instanceId !== expectedLaunch.instanceId ||
      connection.metadata.startedAt !== expectedLaunch.startedAt)
  ) {
    return failure('endpoint_invalid', 'Discovered daemon does not match the launched instance.');
  }

  let ownGrantResponse: GovernanceServiceResponse;
  try {
    ownGrantResponse = await connection.client.request({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: `admin-session-${randomUUID()}`,
      type: 'read_own_capability_grant',
    });
  } catch {
    return failure('service_rejected', 'Governance admin grant could not be inspected.');
  }
  if (!ownGrantResponse.ok) {
    return failure(
      ownGrantResponse.error.code === 'authentication_failed'
        ? 'authentication_failed'
        : 'service_rejected',
      ownGrantResponse.error.message,
    );
  }
  if (ownGrantResponse.result.type !== 'own_capability_grant') {
    return failure('service_rejected', 'Governance service returned an unexpected grant response.');
  }
  const grant = ownGrantResponse.result.grant;
  if (
    grant.grantId !== options.grantId ||
    grant.projectId !== options.projectId ||
    grant.clientId !== options.credential.clientId ||
    grant.status !== 'active'
  ) {
    return failure(
      'grant_mismatch',
      'Governance credential does not match the expected active grant.',
    );
  }
  if (expectedLaunch && grant.expiresAt !== expectedLaunch.expiresAt) {
    return failure('grant_mismatch', 'Governance launch expiry does not match the active grant.');
  }
  if (!grant.capabilities.includes('capability_admin')) {
    return failure('admin_required', 'Governance session requires capability_admin.');
  }

  const lease = new GovernanceCredentialLeaseController({
    projectRoot: options.projectRoot,
    projectId: options.projectId,
    grantId: grant.grantId,
    expiresAt: grant.expiresAt,
    credential: options.credential,
    ...(options.rotationTtlMs === undefined ? {} : { rotationTtlMs: options.rotationTtlMs }),
    ...(options.renewBeforeMs === undefined ? {} : { renewBeforeMs: options.renewBeforeMs }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.timeoutMs === undefined ? {} : { requestTimeoutMs: options.timeoutMs }),
  });
  if (options.startLease !== false) lease.start();
  return {
    connected: true,
    session: new GovernanceAdminSession(
      GOVERNANCE_ADMIN_SESSION_CONSTRUCTION,
      mode,
      connection.metadata,
      lease,
    ),
  };
}

export function connectGovernanceAdminSession(
  options: ConnectGovernanceAdminSessionOptions,
): Promise<ConnectGovernanceAdminSessionResult> {
  return connectAdminSession(options, 'attached');
}

export function connectGovernanceAdminSessionFromLaunch(
  launch: GovernanceProjectDaemonLaunch,
  options: GovernanceAdminSessionLeaseOptions = {},
): Promise<ConnectGovernanceAdminSessionResult> {
  return connectAdminSession(
    {
      projectRoot: launch.projectRoot,
      projectId: launch.projectId,
      grantId: launch.grantId,
      credential: launch.credential,
      ...options,
    },
    'launched',
    {
      pid: launch.pid,
      instanceId: launch.instanceId,
      startedAt: launch.startedAt,
      expiresAt: launch.expiresAt,
    },
  );
}
