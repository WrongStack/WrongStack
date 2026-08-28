import type { GovernanceEventStore } from './event-store.js';
import type { VerificationCheckDescriptor } from './verification-check-binding.js';
import type {
  VerificationCheckRegistry,
  VerificationCheckRegistryDenialCode,
} from './verification-check-registry.js';
import type {
  ConsumeVerificationExecutionLeaseResult,
  VerificationExecutionLeaseConsumption,
  VerificationExecutionLeaseCredential,
} from './verification-execution-lease.js';
import type { VerificationRunContract } from './verification-run-contract.js';

const VERIFICATION_TOOL_GATEWAY_REQUEST_SCHEMA_VERSION = 1 as const;

type VerificationToolGatewayMode = 'legacy' | 'enforced';

/**
 * Contains only canonical identities and a one-time credential. Tool names,
 * commands, paths, and arguments are deliberately not accepted at this boundary.
 */
export interface VerificationToolGatewayRequestV1 {
  readonly schemaVersion: typeof VERIFICATION_TOOL_GATEWAY_REQUEST_SCHEMA_VERSION;
  readonly credential: VerificationExecutionLeaseCredential;
  readonly expected: {
    readonly runId: string;
    readonly taskId: string;
    readonly planFingerprint: string;
  };
}

interface VerificationWorkspaceIdentity {
  readonly manifestHash: string;
}

interface VerificationExecutionLeaseConsumer {
  consumeVerificationExecutionLease: GovernanceEventStore['consumeVerificationExecutionLease'];
}

interface VerificationToolGatewayOptions<Result> {
  /** Defaults to legacy so construction alone can never enable enforcement. */
  readonly mode?: VerificationToolGatewayMode | undefined;
  readonly verifierClientId: string;
  readonly leaseConsumer: VerificationExecutionLeaseConsumer;
  readonly captureWorkspaceIdentity: () => Promise<VerificationWorkspaceIdentity>;
  readonly checkRegistry: VerificationCheckRegistry<Result>;
}

type VerificationLeaseDenialCode = Extract<
  ConsumeVerificationExecutionLeaseResult,
  { readonly authorized: false }
>['code'];

type VerificationToolGatewayDenialCode =
  | VerificationLeaseDenialCode
  | 'request_invalid'
  | 'workspace_identity_unavailable';

type VerificationToolGatewayResult<Result> =
  | {
      readonly route: 'legacy';
      readonly handled: false;
      readonly reason: 'gateway_disabled';
    }
  | {
      readonly route: 'governed';
      readonly handled: true;
      readonly authorized: false;
      readonly code: VerificationToolGatewayDenialCode;
      readonly message: string;
    }
  | {
      readonly route: 'governed';
      readonly handled: true;
      readonly authorized: true;
      readonly outcome: 'succeeded';
      readonly run: VerificationRunContract;
      readonly consumption: VerificationExecutionLeaseConsumption;
      readonly check: VerificationCheckDescriptor;
      readonly result: Result;
    }
  | {
      readonly route: 'governed';
      readonly handled: true;
      readonly authorized: true;
      readonly outcome: 'failed';
      readonly code: 'focused_check_failed' | VerificationCheckRegistryDenialCode;
      readonly message: string;
      readonly run: VerificationRunContract;
      readonly consumption: VerificationExecutionLeaseConsumption;
    };

const SHA256_HEX = /^[a-f0-9]{64}$/;

function boundedIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(record).every((key) => allowedKeys.has(key));
}

function requestIsValid(request: unknown): request is VerificationToolGatewayRequestV1 {
  const root = plainRecord(request);
  const credential = plainRecord(root?.['credential']);
  const expected = plainRecord(root?.['expected']);
  return (
    root !== null &&
    credential !== null &&
    expected !== null &&
    hasOnlyKeys(root, ['schemaVersion', 'credential', 'expected']) &&
    hasOnlyKeys(credential, ['leaseId', 'secret']) &&
    hasOnlyKeys(expected, ['runId', 'taskId', 'planFingerprint']) &&
    root?.['schemaVersion'] === VERIFICATION_TOOL_GATEWAY_REQUEST_SCHEMA_VERSION &&
    boundedIdentity(credential?.['leaseId']) &&
    boundedIdentity(credential?.['secret']) &&
    boundedIdentity(expected?.['runId']) &&
    boundedIdentity(expected?.['taskId']) &&
    typeof expected?.['planFingerprint'] === 'string' &&
    SHA256_HEX.test(expected['planFingerprint'])
  );
}

export class VerificationToolGateway<Result> {
  readonly #mode: VerificationToolGatewayMode;
  readonly #verifierClientId: string;
  readonly #leaseConsumer: VerificationExecutionLeaseConsumer;
  readonly #captureWorkspaceIdentity: () => Promise<VerificationWorkspaceIdentity>;
  readonly #checkRegistry: VerificationCheckRegistry<Result>;

  constructor(options: VerificationToolGatewayOptions<Result>) {
    this.#mode = options.mode === 'enforced' ? 'enforced' : 'legacy';
    this.#verifierClientId = options.verifierClientId;
    this.#leaseConsumer = options.leaseConsumer;
    this.#captureWorkspaceIdentity = options.captureWorkspaceIdentity;
    this.#checkRegistry = options.checkRegistry;
  }

  async execute(
    request: VerificationToolGatewayRequestV1,
  ): Promise<VerificationToolGatewayResult<Result>> {
    if (this.#mode === 'legacy') {
      return Object.freeze({ route: 'legacy', handled: false, reason: 'gateway_disabled' });
    }
    if (!boundedIdentity(this.#verifierClientId) || !requestIsValid(request)) {
      return this.#denied('request_invalid', 'Verification gateway request is invalid.');
    }

    let workspace: VerificationWorkspaceIdentity;
    try {
      workspace = await this.#captureWorkspaceIdentity();
    } catch {
      return this.#denied(
        'workspace_identity_unavailable',
        'Fresh workspace identity could not be captured.',
      );
    }
    const workspaceRecord = plainRecord(workspace);
    const workspaceManifestHash = workspaceRecord?.['manifestHash'];
    if (typeof workspaceManifestHash !== 'string' || !SHA256_HEX.test(workspaceManifestHash)) {
      return this.#denied('workspace_identity_unavailable', 'Fresh workspace identity is invalid.');
    }

    const admission = this.#leaseConsumer.consumeVerificationExecutionLease(request.credential, {
      runId: request.expected.runId,
      taskId: request.expected.taskId,
      verifierClientId: this.#verifierClientId,
      planFingerprint: request.expected.planFingerprint,
      workspaceManifestHash,
    });
    if (!admission.authorized) {
      return this.#denied(admission.code, admission.message);
    }

    const context = Object.freeze({
      run: admission.run,
      consumption: admission.consumption,
      workspaceManifestHash,
    });
    try {
      const execution = await this.#checkRegistry.execute(context);
      if (!execution.executed) {
        return Object.freeze({
          route: 'governed',
          handled: true,
          authorized: true,
          outcome: 'failed',
          code: execution.code,
          message: execution.message,
          run: admission.run,
          consumption: admission.consumption,
        });
      }
      return Object.freeze({
        route: 'governed',
        handled: true,
        authorized: true,
        outcome: 'succeeded',
        run: admission.run,
        consumption: admission.consumption,
        check: execution.descriptor,
        result: execution.result,
      } satisfies Extract<VerificationToolGatewayResult<Result>, { outcome: 'succeeded' }>);
    } catch {
      return Object.freeze({
        route: 'governed',
        handled: true,
        authorized: true,
        outcome: 'failed',
        code: 'focused_check_failed',
        message: 'Focused verification check failed after admission.',
        run: admission.run,
        consumption: admission.consumption,
      });
    }
  }

  #denied(
    code: VerificationToolGatewayDenialCode,
    message: string,
  ): VerificationToolGatewayResult<Result> {
    return Object.freeze({ route: 'governed', handled: true, authorized: false, code, message });
  }
}
