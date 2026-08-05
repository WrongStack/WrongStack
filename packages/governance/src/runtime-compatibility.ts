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
import {
  type GovernanceDaemonAttachmentBrokerRecord,
  type GovernanceDaemonMetadata,
  inspectGovernanceDaemon,
  readGovernanceDaemonAttachmentBroker,
} from './daemon-metadata.js';
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
  | 'attachment_grants_released'
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
  readonly daemon: GovernanceAdminSessionSnapshot['daemon'];
  readonly control: {
    readonly kind: 'admin' | 'attachment';
    readonly clientId: string;
    readonly grantId: string;
    readonly expiresAt: string;
  };
  readonly admin: GovernanceAdminSessionSnapshot | null;
  readonly model: GovernanceModelSessionSnapshot;
}

type GovernanceCompatibilityControl =
  | { readonly kind: 'admin'; readonly session: GovernanceAdminSession }
  | {
      readonly kind: 'attachment';
      readonly client: GovernanceProjectClient;
      readonly metadata: GovernanceDaemonMetadata;
      readonly grant: GovernanceCapabilityGrant;
    };

const GOVERNANCE_COMPATIBILITY_RUNTIME_CONSTRUCTION = Symbol(
  'governance-compatibility-runtime-construction',
);

export class GovernanceCompatibilityRuntime {
  readonly model: GovernanceModelSession;
  readonly #control: GovernanceCompatibilityControl;
  readonly #source: 'attached' | 'launched';
  readonly #modelGrantId: string;
  #closed = false;
  #closePromise: Promise<GovernanceServiceResponse | null> | undefined;

  constructor(
    construction: typeof GOVERNANCE_COMPATIBILITY_RUNTIME_CONSTRUCTION,
    source: 'attached' | 'launched',
    control: GovernanceCompatibilityControl,
    model: GovernanceModelSession,
  ) {
    if (construction !== GOVERNANCE_COMPATIBILITY_RUNTIME_CONSTRUCTION) {
      throw new Error('Governance compatibility runtimes must be created through the factory.');
    }
    this.#source = source;
    this.#control = control;
    this.model = model;
    this.#modelGrantId = model.snapshot().grantId;
  }

  snapshot(): GovernanceCompatibilityRuntimeSnapshot {
    const control = this.#control;
    const admin = control.kind === 'admin' ? control.session.snapshot() : null;
    const daemon =
      control.kind === 'admin'
        ? admin!.daemon
        : Object.freeze({
            projectRoot: control.metadata.projectRoot,
            projectId: control.metadata.projectId,
            pid: control.metadata.pid,
            instanceId: control.metadata.instanceId,
            startedAt: control.metadata.startedAt,
          });
    const controlGrant = control.kind === 'admin' ? admin!.lease : control.grant;
    return Object.freeze({
      source: this.#source,
      closed: this.#closed,
      daemon,
      control: Object.freeze({
        kind: control.kind,
        clientId: controlGrant.clientId,
        grantId: controlGrant.grantId,
        expiresAt: controlGrant.expiresAt,
      }),
      admin,
      model: this.model.snapshot(),
    });
  }

  close(): Promise<GovernanceServiceResponse | null> {
    if (this.#closed) return Promise.resolve(null);
    if (this.#closePromise) return this.#closePromise;
    if (this.#control.kind === 'attachment') {
      this.#closePromise = this.#control.client
        .request({
          protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
          requestId: `compat-release-${randomUUID()}`,
          type: 'release_runtime_attachment',
        })
        .then((response) => {
          if (response.ok && response.result.type === 'runtime_attachment_released') {
            this.#closed = true;
          }
          return response;
        })
        .finally(() => {
          this.#closePromise = undefined;
        });
      return this.#closePromise;
    }
    const adminSession = this.#control.session;
    this.#closePromise = this.revokeModelGrant()
      .then((response) => {
        if (response.ok && response.result.type === 'capability_grant_revoked') {
          this.#closed = true;
        }
        return response;
      })
      .finally(() => {
        // Local teardown is unconditional, and deliberately not tied to whether
        // the *remote* revoke succeeded. Stopping only on success meant that the
        // most likely failure — closing when the daemon is already gone, so the
        // revoke request errors — left the admin lease renewing a
        // capability_admin credential forever, with its timer still armed in a
        // process that was trying to exit.
        //
        // Stopping the lease only stops renewal; the credential already held
        // stays valid until its own TTL, so a prompt retry of `close()` can
        // still authenticate, and an abandoned runtime now expires on its own.
        // `#closed` still reflects the remote outcome rather than the local one.
        adminSession.stop();
        this.#closePromise = undefined;
      });
    return this.#closePromise;
  }

  async shutdownDaemon(
    reason = 'governance compatibility runtime requested graceful shutdown',
  ): Promise<GovernanceServiceResponse> {
    if (this.#control.kind === 'attachment') {
      return {
        ok: false,
        requestId: `compat-shutdown-denied-${randomUUID()}`,
        error: {
          code: 'permission_denied',
          message: 'Attached runtimes cannot shut down the project governance daemon.',
        },
      };
    }
    if (!this.#closed) await this.close().catch(() => null);
    const response = await this.#control.session.shutdownDaemon(reason);
    if (response.ok && response.result.type === 'daemon_shutdown_accepted') this.#closed = true;
    return response;
  }

  recordWorkspaceSnapshot(manifestHash: string): Promise<GovernanceServiceResponse> {
    const client = this.#control.kind === 'admin' ? this.#control.session : this.#control.client;
    return client.request({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: `workspace-snapshot-${randomUUID()}`,
      type: 'record_workspace_snapshot',
      manifestHash,
    });
  }

  private revokeModelGrant(): Promise<GovernanceServiceResponse> {
    if (this.#control.kind !== 'admin') {
      throw new Error('Attached runtimes release their paired grants through the control grant.');
    }
    return this.#control.session.request({
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
  readonly readAttachmentBroker: typeof readGovernanceDaemonAttachmentBroker;
}

const DEFAULT_ADAPTERS: GovernanceCompatibilityAdapters = {
  inspect: inspectGovernanceDaemon,
  launch: launchGovernanceProjectDaemon,
  connectAttached: connectGovernanceAdminSession,
  connectLaunched: connectGovernanceAdminSessionFromLaunch,
  connectModel: connectGovernanceProjectClient,
  readAttachmentBroker: readGovernanceDaemonAttachmentBroker,
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

function attachmentClaimMatches(
  response: GovernanceServiceResponse,
  options: PrepareGovernanceCompatibilityOptions,
): response is Extract<GovernanceServiceResponse, { readonly ok: true }> & {
  readonly result: Extract<
    Extract<GovernanceServiceResponse, { readonly ok: true }>['result'],
    { readonly type: 'runtime_attachment_claimed' }
  >;
} {
  if (!response.ok || response.result.type !== 'runtime_attachment_claimed') return false;
  const { control, model } = response.result;
  return (
    control.grant.projectId === options.projectId &&
    control.grant.clientId === options.adminClientId &&
    control.grant.status === 'active' &&
    control.grant.capabilities.length === 3 &&
    control.grant.capabilities.includes('workspace_snapshot_record') &&
    control.grant.capabilities.includes('runtime_attachment_release') &&
    control.grant.capabilities.includes('daemon_status_read') &&
    control.credential.projectId === options.projectId &&
    control.credential.clientId === options.adminClientId &&
    control.credential.token.startsWith(`wsg_${control.grant.grantId}.`) &&
    model.grant.projectId === options.projectId &&
    model.grant.clientId === options.modelClientId &&
    model.grant.status === 'active' &&
    model.credential.projectId === options.projectId &&
    model.credential.clientId === options.modelClientId &&
    model.credential.token.startsWith(`wsg_${model.grant.grantId}.`) &&
    model.grant.capabilities.length === options.modelCapabilities.length &&
    model.grant.capabilities.every((capability) =>
      options.modelCapabilities.includes(capability as GovernanceModelCapability),
    ) &&
    Number.isFinite(Date.parse(control.grant.expiresAt)) &&
    Number.isFinite(Date.parse(model.grant.expiresAt))
  );
}

async function provisionAttachment(
  options: PrepareGovernanceCompatibilityOptions,
  adapters: GovernanceCompatibilityAdapters,
  metadata: GovernanceDaemonMetadata,
  broker: GovernanceDaemonAttachmentBrokerRecord,
): Promise<PrepareGovernanceCompatibilityResult> {
  let brokerConnection: ConnectGovernanceProjectClientResult;
  try {
    brokerConnection = await adapters.connectModel({
      projectRoot: options.projectRoot,
      projectId: options.projectId,
      credential: broker.credential,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  } catch (error) {
    return legacy(
      'attachment_rejected',
      'attach',
      `Governance attachment broker connection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!brokerConnection.connected) {
    return legacy('attachment_rejected', 'attach', brokerConnection.message);
  }
  let claim: GovernanceServiceResponse;
  try {
    claim = await brokerConnection.client.request({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: `compat-attach-${randomUUID()}`,
      type: 'claim_runtime_attachment',
      controlClientId: options.adminClientId,
      modelClientId: options.modelClientId,
      modelCapabilities: options.modelCapabilities,
      ttlMs: options.modelTtlMs ?? GOVERNANCE_COMPATIBILITY_MODEL_TTL_MS,
    });
  } catch (error) {
    return legacy(
      'attachment_rejected',
      'attach',
      `Governance attachment claim failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!attachmentClaimMatches(claim, options)) {
    return legacy(
      'attachment_rejected',
      'attach',
      claim.ok
        ? 'Governance attachment response did not match the requested identities and capabilities.'
        : `Governance attachment was rejected: ${claim.error.message}`,
    );
  }
  const releaseClaim = (): Promise<GovernanceServiceResponse | null> =>
    new GovernanceProjectClient(options.projectRoot, claim.result.control.credential, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
      .request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: `compat-release-failed-connect-${randomUUID()}`,
        type: 'release_runtime_attachment',
      })
      .catch(() => null);
  let controlConnection: ConnectGovernanceProjectClientResult;
  let modelConnection: ConnectGovernanceProjectClientResult;
  try {
    [controlConnection, modelConnection] = await Promise.all([
      adapters.connectModel({
        projectRoot: options.projectRoot,
        projectId: options.projectId,
        credential: claim.result.control.credential,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      }),
      adapters.connectModel({
        projectRoot: options.projectRoot,
        projectId: options.projectId,
        credential: claim.result.model.credential,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      }),
    ]);
  } catch (error) {
    const released = await releaseClaim();
    const cleanup =
      released?.ok && released.result.type === 'runtime_attachment_released'
        ? 'attachment_grants_released'
        : 'cleanup_failed';
    return legacy(
      'model_connection_rejected',
      'provision',
      `Governance attachment client connection failed: ${error instanceof Error ? error.message : String(error)}`,
      cleanup,
    );
  }
  if (!controlConnection.connected || !modelConnection.connected) {
    const released = await releaseClaim();
    const cleanup =
      released?.ok && released.result.type === 'runtime_attachment_released'
        ? 'attachment_grants_released'
        : 'cleanup_failed';
    const connectionMessage = !controlConnection.connected
      ? controlConnection.message
      : !modelConnection.connected
        ? modelConnection.message
        : 'Governance attachment clients could not be verified.';
    return legacy('model_connection_rejected', 'provision', connectionMessage, cleanup);
  }
  const model = new GovernanceModelSession(
    GOVERNANCE_MODEL_SESSION_CONSTRUCTION,
    modelConnection.client,
    claim.result.model.grant,
  );
  return Object.freeze({
    mode: 'governed',
    runtime: new GovernanceCompatibilityRuntime(
      GOVERNANCE_COMPATIBILITY_RUNTIME_CONSTRUCTION,
      'attached',
      {
        kind: 'attachment',
        client: controlConnection.client,
        metadata,
        grant: claim.result.control.grant,
      },
      model,
    ),
  });
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
      { kind: 'admin', session },
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
      let broker: Awaited<ReturnType<typeof readGovernanceDaemonAttachmentBroker>>;
      try {
        broker = await adapters.readAttachmentBroker(options.projectRoot);
      } catch (error) {
        return legacy(
          'attachment_rejected',
          'attach',
          `Governance attachment broker could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (broker.kind === 'missing') {
        return legacy(
          'existing_owner_requires_credential',
          'inspect',
          'The existing governance daemon does not publish a compatible attachment broker.',
        );
      }
      if (broker.kind === 'invalid') {
        return legacy('attachment_rejected', 'attach', broker.reason);
      }
      if (
        broker.broker.projectId !== options.projectId ||
        broker.broker.pid !== inspection.metadata.pid ||
        broker.broker.instanceId !== inspection.metadata.instanceId ||
        broker.broker.projectKey !== inspection.metadata.projectKey ||
        broker.broker.projectRoot !== inspection.metadata.projectRoot ||
        Date.parse(broker.broker.expiresAt) <= Date.now()
      ) {
        return legacy(
          'attachment_rejected',
          'attach',
          'Governance attachment broker does not match the live daemon identity or has expired.',
        );
      }
      return provisionAttachment(options, adapters, inspection.metadata, broker.broker);
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
