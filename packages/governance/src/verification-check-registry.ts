import { EVIDENCE_KINDS, type EvidenceKind } from './task-contract.js';
import {
  calculateVerificationCheckRegistryFingerprint,
  createVerificationCheckBinding,
  type VerificationCheckBindingV1,
  type VerificationCheckDescriptor,
  verificationCheckBindingMatches,
} from './verification-check-binding.js';
import type { VerificationExecutionLeaseConsumption } from './verification-execution-lease.js';
import {
  isVerificationRunContractIntegrityValid,
  type VerificationRunContract,
} from './verification-run-contract.js';

export const MAX_VERIFICATION_CHECK_REGISTRATIONS = 256;

interface FocusedVerificationExecutionContext {
  readonly run: VerificationRunContract;
  readonly consumption: VerificationExecutionLeaseConsumption;
  readonly workspaceManifestHash: string;
}

export interface VerificationCheckRegistration<Result> extends VerificationCheckDescriptor {
  readonly run: (context: FocusedVerificationExecutionContext) => Promise<Result>;
}

export type VerificationCheckRegistryDenialCode =
  | 'check_not_registered'
  | 'evidence_kind_mismatch'
  | 'check_binding_missing'
  | 'check_binding_drifted'
  | 'execution_context_invalid';

export type VerificationCheckBindingResolution =
  | { readonly bound: true; readonly binding: VerificationCheckBindingV1 }
  | {
      readonly bound: false;
      readonly code: 'check_not_registered' | 'evidence_kind_mismatch';
      readonly message: string;
    };

type VerificationCheckRegistryExecutionResult<Result> =
  | {
      readonly executed: false;
      readonly code: VerificationCheckRegistryDenialCode;
      readonly message: string;
    }
  | {
      readonly executed: true;
      readonly descriptor: VerificationCheckDescriptor;
      readonly result: Result;
    };

export class VerificationCheckRegistryConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationCheckRegistryConfigurationError';
  }
}

interface StoredVerificationCheck<Result> {
  readonly descriptor: VerificationCheckDescriptor;
  readonly run: VerificationCheckRegistration<Result>['run'];
}

const CHECK_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const HANDLER_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

function validateRegistration<Result>(
  registration: VerificationCheckRegistration<Result>,
  index: number,
): void {
  if (!CHECK_ID.test(registration.id)) {
    throw new VerificationCheckRegistryConfigurationError(
      `Verification check registration ${index} has an invalid canonical id.`,
    );
  }
  if (!EVIDENCE_KINDS.includes(registration.evidenceKind)) {
    throw new VerificationCheckRegistryConfigurationError(
      `Verification check registration "${registration.id}" has an invalid evidence kind.`,
    );
  }
  if (!HANDLER_VERSION.test(registration.handlerVersion)) {
    throw new VerificationCheckRegistryConfigurationError(
      `Verification check registration "${registration.id}" has an invalid handler version.`,
    );
  }
  if (registration.executionClass !== 'trusted_deterministic') {
    throw new VerificationCheckRegistryConfigurationError(
      `Verification check registration "${registration.id}" has an invalid execution class.`,
    );
  }
  if (typeof registration.run !== 'function') {
    throw new VerificationCheckRegistryConfigurationError(
      `Verification check registration "${registration.id}" is missing its trusted handler.`,
    );
  }
}

function contextIsValid(context: FocusedVerificationExecutionContext): boolean {
  return (
    isVerificationRunContractIntegrityValid(context.run) &&
    context.run.authorization.operation === 'focused_check' &&
    context.run.resultPolicy.executorMayApprove === false &&
    context.consumption.runId === context.run.runId &&
    context.consumption.verifierClientId === context.run.verifierClientId &&
    SHA256_HEX.test(context.workspaceManifestHash) &&
    context.workspaceManifestHash === context.run.workspaceManifestHash
  );
}

export class VerificationCheckRegistry<Result> {
  readonly #checks: ReadonlyMap<string, StoredVerificationCheck<Result>>;
  readonly #descriptors: readonly VerificationCheckDescriptor[];
  readonly #fingerprint: string;

  constructor(registrations: readonly VerificationCheckRegistration<Result>[]) {
    if (registrations.length > MAX_VERIFICATION_CHECK_REGISTRATIONS) {
      throw new VerificationCheckRegistryConfigurationError(
        `Verification check registry exceeds ${MAX_VERIFICATION_CHECK_REGISTRATIONS} registrations.`,
      );
    }
    const checks = new Map<string, StoredVerificationCheck<Result>>();
    for (const [index, registration] of registrations.entries()) {
      validateRegistration(registration, index);
      if (checks.has(registration.id)) {
        throw new VerificationCheckRegistryConfigurationError(
          `Duplicate verification check registration "${registration.id}".`,
        );
      }
      const descriptor = Object.freeze({
        id: registration.id,
        evidenceKind: registration.evidenceKind,
        handlerVersion: registration.handlerVersion,
        executionClass: 'trusted_deterministic' as const,
      });
      checks.set(registration.id, Object.freeze({ descriptor, run: registration.run }));
    }
    this.#checks = checks;
    this.#descriptors = Object.freeze(
      [...checks.values()]
        .map((entry) => entry.descriptor)
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    );
    this.#fingerprint = calculateVerificationCheckRegistryFingerprint(this.#descriptors);
  }

  list(): readonly VerificationCheckDescriptor[] {
    return this.#descriptors;
  }

  fingerprint(): string {
    return this.#fingerprint;
  }

  bindingFor(checkId: string, evidenceKind: EvidenceKind): VerificationCheckBindingResolution {
    const check = this.#checks.get(checkId);
    if (!check) {
      return Object.freeze({
        bound: false,
        code: 'check_not_registered',
        message: `Required check "${checkId}" is not registered.`,
      });
    }
    if (check.descriptor.evidenceKind !== evidenceKind) {
      return Object.freeze({
        bound: false,
        code: 'evidence_kind_mismatch',
        message: `Required check "${checkId}" is not registered for the expected evidence kind.`,
      });
    }
    return Object.freeze({
      bound: true,
      binding: createVerificationCheckBinding(this.#fingerprint, check.descriptor),
    });
  }

  async execute(
    context: FocusedVerificationExecutionContext,
  ): Promise<VerificationCheckRegistryExecutionResult<Result>> {
    if (!contextIsValid(context)) {
      return Object.freeze({
        executed: false,
        code: 'execution_context_invalid',
        message: 'Focused verification execution context failed integrity checks.',
      });
    }
    if (context.run.schemaVersion === 1) {
      return Object.freeze({
        executed: false,
        code: 'check_binding_missing',
        message: 'Legacy verification run is not bound to a check registry snapshot.',
      });
    }
    const check = this.#checks.get(context.run.requiredCheckId);
    if (!check) {
      return Object.freeze({
        executed: false,
        code: 'check_not_registered',
        message: `Required check "${context.run.requiredCheckId}" is not registered.`,
      });
    }
    if (check.descriptor.evidenceKind !== context.run.expectedEvidenceKind) {
      return Object.freeze({
        executed: false,
        code: 'evidence_kind_mismatch',
        message: `Required check "${context.run.requiredCheckId}" is not registered for the expected evidence kind.`,
      });
    }
    if (
      !verificationCheckBindingMatches(
        context.run.checkBinding,
        this.#fingerprint,
        check.descriptor,
      )
    ) {
      return Object.freeze({
        executed: false,
        code: 'check_binding_drifted',
        message: `Required check "${context.run.requiredCheckId}" no longer matches its authorized registry binding.`,
      });
    }
    const result = await check.run(context);
    return Object.freeze({
      executed: true,
      descriptor: check.descriptor,
      result: result as Result,
    } satisfies Extract<VerificationCheckRegistryExecutionResult<Result>, { executed: true }>);
  }
}
