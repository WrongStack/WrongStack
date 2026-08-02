import { randomUUID } from 'node:crypto';

import {
  type ConnectGovernanceAdminSessionOptions,
  type ConnectGovernanceAdminSessionResult,
  connectGovernanceAdminSession,
  connectGovernanceAdminSessionFromLaunch,
  type GovernanceAdminSession,
  type GovernanceAdminSessionLeaseOptions,
  type GovernanceAdminSessionSnapshot,
} from './admin-session.js';
import {
  DEFAULT_GOVERNANCE_GRANT_MAX_TTL_MS,
  type GovernanceCapabilityGrant,
  type GovernanceServiceCredential,
} from './capability-grant.js';
import {
  GovernanceDaemonLaunchError,
  type GovernanceProjectDaemonLaunch,
  launchGovernanceProjectDaemon,
} from './daemon-launcher.js';
import { inspectGovernanceDaemon } from './daemon-metadata.js';
import {
  type ConnectGovernanceProjectClientResult,
  connectGovernanceProjectClient,
  GovernanceProjectClient,
} from './project-client.js';
import type { GovernanceServiceResponse } from './project-service.js';
import { sanitizeGovernanceMessage } from './sanitize.js';
import {
  GOVERNANCE_RUNTIME_MODEL_CAPABILITIES,
  GOVERNANCE_SERVICE_CAPABILITIES,
  GOVERNANCE_SERVICE_PROTOCOL_VERSION,
  type GovernanceRuntimeModelCapability,
  type GovernanceServiceCapability,
} from './service-protocol.js';

export const GOVERNANCE_COMPATIBILITY_ADMIN_TTL_MS = 60 * 60 * 1_000;
export const GOVERNANCE_COMPATIBILITY_MODEL_TTL_MS = 30 * 60 * 1_000;

export type GovernanceModelCapability = GovernanceRuntimeModelCapability;

export interface ExistingGovernanceAdminCredential {
  readonly grantId: string;
  readonly credential: GovernanceServiceCredential;
}

export interface PrepareGovernanceCompatibilityOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly adminClientId: string;
  readonly modelClientId: string;
  readonly modelCapabilities: readonly GovernanceModelCapability[];
  readonly adminTtlMs?: number | undefined;
  readonly modelTtlMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly existingAdmin?: ExistingGovernanceAdminCredential | undefined;
  readonly adminLease?: GovernanceAdminSessionLeaseOptions | undefined;
}

export type GovernanceCompatibilityFallbackCode =
  | 'invalid_options'
  | 'inspection_failed'
  | 'existing_owner_requires_credential'
  | 'unsafe_daemon_state'
  | 'attachment_rejected'
  | 'launch_failed'
  | 'admin_session_rejected'
  | 'model_grant_rejected'
  | 'model_connection_rejected';

export type GovernanceCompatibilityCleanup =
  | 'not_required'
  | 'admin_session_stopped'
  | 'launched_daemon_shutdown_requested'
  | 'cleanup_failed'
  | 'unavailable';

export interface GovernanceCompatibilityFallback {
  readonly mode: 'legacy';
  readonly code: GovernanceCompatibilityFallbackCode;
  readonly phase: 'validate' | 'inspect' | 'attach' | 'launch' | 'provision';
  readonly message: string;
  readonly cleanup: GovernanceCompatibilityCleanup;
}

export interface GovernanceModelSessionSnapshot {
  readonly projectId: string;
  readonly clientId: string;
  readonly grantId: string;
  readonly capabilities: readonly GovernanceModelCapability[];
  readonly expiresAt: string;
}

const GOVERNANCE_MODEL_SESSION_CONSTRUCTION = Symbol('governance-model-session-construction');

export class GovernanceModelSession {
  readonly #client: GovernanceProjectClient;
  readonly #snapshot: GovernanceModelSessionSnapshot;

  constructor(
    construction: typeof GOVERNANCE_MODEL_SESSION_CONSTRUCTION,
    client: GovernanceProjectClient,
    grant: GovernanceCapabilityGrant,
  ) {
    if (construction !== GOVERNANCE_MODEL_SESSION_CONSTRUCTION) {
      throw new Error(
        'Governance model sessions must be created through the compatibility factory.',
      );
    }
    this.#client = client;
    this.#snapshot = Object.freeze({
      projectId: grant.projectId,
      clientId: grant.clientId,
      grantId: grant.grantId,
      capabilities: Object.freeze([...grant.capabilities]) as readonly GovernanceModelCapability[],
      expiresAt: grant.expiresAt,
    });
  }

  request(input: unknown): Promise<GovernanceServiceResponse> {
    return this.#client.request(input);
  }

  snapshot(): GovernanceModelSessionSnapshot {
    return this.#snapshot;
  }
}

export interface GovernanceCompatibilityRuntimeSnapshot {
  readonly source: 'attached' | 'launched';
  readonly closed: boolean;
  readonly admin: GovernanceAdminSessionSnapshot;
  readonly model: GovernanceModelSessionSnapshot;
}

const GOVERNANCE_COMPATIBILITY_RUNTIME_CONSTRUCTION = Symbol(
  'governance-compatibility-runtime-construction',
);

export class GovernanceCompatibilityRuntime {
  readonly model: GovernanceModelSession;
  readonly #admin: GovernanceAdminSession;
  readonly #source: 'attached' | 'launched';
  readonly #modelGrantId: string;
  #closed = false;
  #closePromise: Promise<GovernanceServiceResponse | null> | undefined;

  constructor(
    construction: typeof GOVERNANCE_COMPATIBILITY_RUNTIME_CONSTRUCTION,
    source: 'attached' | 'launched',
    admin: GovernanceAdminSession,
    model: GovernanceModelSession,
  ) {
    if (construction !== GOVERNANCE_COMPATIBILITY_RUNTIME_CONSTRUCTION) {
      throw new Error('Governance compatibility runtimes must be created through the factory.');
    }
    this.#source = source;
    this.#admin = admin;
    this.model = model;
    this.#modelGrantId = model.snapshot().grantId;
  }

  snapshot(): GovernanceCompatibilityRuntimeSnapshot {
    return Object.freeze({
      source: this.#source,
      closed: this.#closed,
      admin: this.#admin.snapshot(),
      model: this.model.snapshot(),
    });
  }

  close(): Promise<GovernanceServiceResponse | null> {
    if (this.#closed) return Promise.resolve(null);
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.revokeModelGrant()
      .then((response) => {
        if (response.ok && response.result.type === 'capability_grant_revoked') {
          this.#closed = true;
          this.#admin.stop();
        }
        return response;
      })
      .finally(() => {
        this.#closePromise = undefined;
      });
    return this.#closePromise;
  }

  async shutdownDaemon(
    reason = 'governance compatibility runtime requested graceful shutdown',
  ): Promise<GovernanceServiceResponse> {
    if (!this.#closed) await this.close().catch(() => null);
    const response = await this.#admin.shutdownDaemon(reason);
    if (response.ok && response.result.type === 'daemon_shutdown_accepted') this.#closed = true;
    return response;
  }

  recordWorkspaceSnapshot(manifestHash: string): Promise<GovernanceServiceResponse> {
    return this.#admin.request({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: `workspace-snapshot-${randomUUID()}`,
      type: 'record_workspace_snapshot',
      manifestHash,
    });
  }

  private revokeModelGrant(): Promise<GovernanceServiceResponse> {
    return this.#admin.request({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: `compat-revoke-${randomUUID()}`,
      type: 'revoke_capability_grant',
      grantId: this.#modelGrantId,
      reason: 'governance compatibility runtime closed',
    });
  }
}

export type PrepareGovernanceCompatibilityResult =
  | { readonly mode: 'governed'; readonly runtime: GovernanceCompatibilityRuntime }
  | GovernanceCompatibilityFallback;

interface GovernanceCompatibilityAdapters {
  readonly inspect: typeof inspectGovernanceDaemon;
  readonly launch: typeof launchGovernanceProjectDaemon;
  readonly connectAttached: (
    options: ConnectGovernanceAdminSessionOptions,
  ) => Promise<ConnectGovernanceAdminSessionResult>;
  readonly connectLaunched: (
    launch: GovernanceProjectDaemonLaunch,
    options?: GovernanceAdminSessionLeaseOptions,
  ) => Promise<ConnectGovernanceAdminSessionResult>;
  readonly connectModel: typeof connectGovernanceProjectClient;
}

const DEFAULT_ADAPTERS: GovernanceCompatibilityAdapters = {
  inspect: inspectGovernanceDaemon,
  launch: launchGovernanceProjectDaemon,
  connectAttached: connectGovernanceAdminSession,
  connectLaunched: connectGovernanceAdminSessionFromLaunch,
  connectModel: connectGovernanceProjectClient,
};

function legacy(
  code: GovernanceCompatibilityFallbackCode,
  phase: GovernanceCompatibilityFallback['phase'],
  message: string,
  cleanup: GovernanceCompatibilityCleanup = 'not_required',
): GovernanceCompatibilityFallback {
  return Object.freeze({
    mode: 'legacy',
    code,
    phase,
    message: sanitizeGovernanceMessage(message),
    cleanup,
  });
}

function validateOptions(options: PrepareGovernanceCompatibilityOptions): string | null {
  if (options.projectRoot.trim().length === 0) return 'projectRoot must not be empty.';
  for (const [name, value] of [
    ['projectId', options.projectId],
    ['adminClientId', options.adminClientId],
    ['modelClientId', options.modelClientId],
  ] as const) {
    if (value.trim().length === 0 || value.length > 512) {
      return `${name} must be a non-empty string of at most 512 characters.`;
    }
  }
  if (options.adminClientId === options.modelClientId) {
    return 'adminClientId and modelClientId must be different identities.';
  }
  const adminTtlMs = options.adminTtlMs ?? GOVERNANCE_COMPATIBILITY_ADMIN_TTL_MS;
  const modelTtlMs = options.modelTtlMs ?? GOVERNANCE_COMPATIBILITY_MODEL_TTL_MS;
  for (const [name, value] of [
    ['adminTtlMs', adminTtlMs],
    ['modelTtlMs', modelTtlMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_GOVERNANCE_GRANT_MAX_TTL_MS) {
      return `${name} must be a positive safe integer no greater than ${DEFAULT_GOVERNANCE_GRANT_MAX_TTL_MS}.`;
    }
  }
  const capabilities = new Set<GovernanceServiceCapability>(options.modelCapabilities);
  if (capabilities.size === 0 || capabilities.size !== options.modelCapabilities.length) {
    return 'modelCapabilities must contain at least one unique model-safe capability.';
  }
  for (const capability of capabilities) {
    if (
      !GOVERNANCE_SERVICE_CAPABILITIES.includes(capability) ||
      !GOVERNANCE_RUNTIME_MODEL_CAPABILITIES.includes(
        capability as GovernanceRuntimeModelCapability,
      )
    ) {
      return `Capability ${String(capability)} is not model-safe.`;
    }
  }
  if (
    options.existingAdmin &&
    options.existingAdmin.credential.clientId !== options.adminClientId
  ) {
    return 'Existing admin credential identity does not match adminClientId.';
  }
  return null;
}

function modelGrantMatches(
  response: GovernanceServiceResponse,
  options: PrepareGovernanceCompatibilityOptions,
): response is Extract<GovernanceServiceResponse, { readonly ok: true }> & {
  readonly result: Extract<
    Extract<GovernanceServiceResponse, { readonly ok: true }>['result'],
    { readonly type: 'capability_grant_issued' }
  >;
} {
  if (!response.ok || response.result.type !== 'capability_grant_issued') return false;
  const { credential, grant } = response.result;
  return (
    grant.projectId === options.projectId &&
    grant.clientId === options.modelClientId &&
    grant.status === 'active' &&
    credential.projectId === options.projectId &&
    credential.clientId === options.modelClientId &&
    credential.token.startsWith(`wsg_${grant.grantId}.`) &&
    grant.capabilities.length === options.modelCapabilities.length &&
    grant.capabilities.every((capability) =>
      options.modelCapabilities.includes(capability as GovernanceModelCapability),
    ) &&
    Number.isFinite(Date.parse(grant.expiresAt))
  );
}

async function cleanupFailedProvision(
  session: GovernanceAdminSession,
  source: 'attached' | 'launched',
): Promise<GovernanceCompatibilityCleanup> {
  if (source === 'attached') {
    session.stop();
    return 'admin_session_stopped';
  }
  try {
    const response = await session.shutdownDaemon('governance compatibility provisioning failed');
    if (response.ok && response.result.type === 'daemon_shutdown_accepted') {
      return 'launched_daemon_shutdown_requested';
    }
  } catch {
    // Report the explicit cleanup failure below.
  }
  session.stop();
  return 'cleanup_failed';
}

async function cleanupUnconnectedLaunch(
  launch: GovernanceProjectDaemonLaunch,
  timeoutMs?: number | undefined,
): Promise<GovernanceCompatibilityCleanup> {
  try {
    const client = new GovernanceProjectClient(launch.projectRoot, launch.credential, {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    const response = await client.request({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: `compat-cleanup-${randomUUID()}`,
      type: 'request_daemon_shutdown',
      expectedInstanceId: launch.instanceId,
      reason: 'governance compatibility admin session verification failed',
    });
    if (response.ok && response.result.type === 'daemon_shutdown_accepted') {
      return 'launched_daemon_shutdown_requested';
    }
  } catch {
    // Report the explicit cleanup failure below.
  }
  return 'cleanup_failed';
}

async function provisionModel(
  options: PrepareGovernanceCompatibilityOptions,
  adapters: GovernanceCompatibilityAdapters,
  session: GovernanceAdminSession,
  source: 'attached' | 'launched',
): Promise<PrepareGovernanceCompatibilityResult> {
  let response: GovernanceServiceResponse;
  try {
    response = await session.request({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: `compat-issue-${randomUUID()}`,
      type: 'issue_capability_grant',
      clientId: options.modelClientId,
      capabilities: options.modelCapabilities,
      ttlMs: options.modelTtlMs ?? GOVERNANCE_COMPATIBILITY_MODEL_TTL_MS,
    });
  } catch (error) {
    const cleanup = await cleanupFailedProvision(session, source);
    return legacy(
      'model_grant_rejected',
      'provision',
      `Governance model grant request failed: ${error instanceof Error ? error.message : String(error)}`,
      cleanup,
    );
  }
  if (!modelGrantMatches(response, options)) {
    const cleanup = await cleanupFailedProvision(session, source);
    return legacy(
      'model_grant_rejected',
      'provision',
      response.ok
        ? 'Governance model grant response did not match the requested identity and capabilities.'
        : `Governance model grant was rejected: ${response.error.message}`,
      cleanup,
    );
  }

  let modelConnection: ConnectGovernanceProjectClientResult;
  try {
    modelConnection = await adapters.connectModel({
      projectRoot: options.projectRoot,
      projectId: options.projectId,
      credential: response.result.credential,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  } catch (error) {
    await session
      .request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: `compat-revoke-failed-connect-${randomUUID()}`,
        type: 'revoke_capability_grant',
        grantId: response.result.grant.grantId,
        reason: 'model connection verification failed',
      })
      .catch(() => null);
    const cleanup = await cleanupFailedProvision(session, source);
    return legacy(
      'model_connection_rejected',
      'provision',
      `Governance model connection failed: ${error instanceof Error ? error.message : String(error)}`,
      cleanup,
    );
  }
  if (!modelConnection.connected) {
    await session
      .request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: `compat-revoke-failed-connect-${randomUUID()}`,
        type: 'revoke_capability_grant',
        grantId: response.result.grant.grantId,
        reason: 'model connection verification failed',
      })
      .catch(() => null);
    const cleanup = await cleanupFailedProvision(session, source);
    return legacy('model_connection_rejected', 'provision', modelConnection.message, cleanup);
  }

  const model = new GovernanceModelSession(
    GOVERNANCE_MODEL_SESSION_CONSTRUCTION,
    modelConnection.client,
    response.result.grant,
  );
  return Object.freeze({
    mode: 'governed',
    runtime: new GovernanceCompatibilityRuntime(
      GOVERNANCE_COMPATIBILITY_RUNTIME_CONSTRUCTION,
      source,
      session,
      model,
    ),
  });
}

export function prepareGovernanceCompatibilityRuntime(
  options: PrepareGovernanceCompatibilityOptions,
): Promise<PrepareGovernanceCompatibilityResult> {
  return prepareGovernanceCompatibilityRuntimeWithAdapters(options, DEFAULT_ADAPTERS);
}

/** Internal source-test seam. Package consumers use prepareGovernanceCompatibilityRuntime. */
export async function prepareGovernanceCompatibilityRuntimeWithAdapters(
  options: PrepareGovernanceCompatibilityOptions,
  adapters: GovernanceCompatibilityAdapters,
): Promise<PrepareGovernanceCompatibilityResult> {
  const invalid = validateOptions(options);
  if (invalid) return legacy('invalid_options', 'validate', invalid);

  let sessionResult: ConnectGovernanceAdminSessionResult | undefined;
  let source: 'attached' | 'launched' = 'attached';
  if (options.existingAdmin) {
    try {
      sessionResult = await adapters.connectAttached({
        projectRoot: options.projectRoot,
        projectId: options.projectId,
        grantId: options.existingAdmin.grantId,
        credential: options.existingAdmin.credential,
        ...(options.adminLease ?? {}),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    } catch (error) {
      return legacy(
        'attachment_rejected',
        'attach',
        `Governance admin attachment failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!sessionResult.connected && sessionResult.code !== 'not_running') {
      return legacy('attachment_rejected', 'attach', sessionResult.message);
    }
  } else {
    let inspection: Awaited<ReturnType<typeof inspectGovernanceDaemon>>;
    try {
      inspection = await adapters.inspect(options.projectRoot);
    } catch (error) {
      return legacy(
        'inspection_failed',
        'inspect',
        `Governance daemon inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (inspection.kind === 'live') {
      return legacy(
        'existing_owner_requires_credential',
        'inspect',
        'A governance daemon already owns this project; an explicit admin credential is required to attach.',
      );
    }
    if (
      inspection.kind === 'endpoint_invalid' ||
      (inspection.kind === 'stale' && inspection.metadataState === 'invalid')
    ) {
      return legacy(
        'unsafe_daemon_state',
        'inspect',
        inspection.kind === 'endpoint_invalid'
          ? inspection.reason
          : 'Governance daemon metadata is invalid.',
      );
    }
  }

  if (!sessionResult?.connected) {
    source = 'launched';
    let launch: GovernanceProjectDaemonLaunch;
    try {
      launch = await adapters.launch({
        projectRoot: options.projectRoot,
        projectId: options.projectId,
        clientId: options.adminClientId,
        capabilities: ['capability_admin', 'daemon_control', 'workspace_snapshot_record'],
        ttlMs: options.adminTtlMs ?? GOVERNANCE_COMPATIBILITY_ADMIN_TTL_MS,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    } catch (error) {
      return legacy(
        'launch_failed',
        'launch',
        error instanceof GovernanceDaemonLaunchError
          ? error.message
          : `Governance daemon launch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      sessionResult = await adapters.connectLaunched(launch, {
        ...(options.adminLease ?? {}),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    } catch (error) {
      const cleanup = await cleanupUnconnectedLaunch(launch, options.timeoutMs);
      return legacy(
        'admin_session_rejected',
        'launch',
        `Governance admin session verification failed: ${error instanceof Error ? error.message : String(error)}`,
        cleanup,
      );
    }
    if (!sessionResult.connected) {
      const cleanup = await cleanupUnconnectedLaunch(launch, options.timeoutMs);
      return legacy('admin_session_rejected', 'launch', sessionResult.message, cleanup);
    }
  }

  return provisionModel(options, adapters, sessionResult.session, source);
}
