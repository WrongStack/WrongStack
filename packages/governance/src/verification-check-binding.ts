import { createHash } from 'node:crypto';
import { EVIDENCE_KINDS, type EvidenceKind } from './task-contract.js';

const VERIFICATION_CHECK_BINDING_SCHEMA_VERSION = 1 as const;

export interface VerificationCheckDescriptor {
  readonly id: string;
  readonly evidenceKind: EvidenceKind;
  readonly handlerVersion: string;
  readonly executionClass: 'trusted_deterministic';
}

export interface VerificationCheckBindingV1 {
  readonly schemaVersion: typeof VERIFICATION_CHECK_BINDING_SCHEMA_VERSION;
  readonly registryFingerprint: string;
  readonly checkId: string;
  readonly evidenceKind: EvidenceKind;
  readonly handlerVersion: string;
  readonly executionClass: 'trusted_deterministic';
  readonly handlerFingerprint: string;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const CHECK_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const HANDLER_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/;

function calculateVerificationCheckHandlerFingerprint(
  descriptor: VerificationCheckDescriptor,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: descriptor.id,
        evidenceKind: descriptor.evidenceKind,
        handlerVersion: descriptor.handlerVersion,
        executionClass: descriptor.executionClass,
      }),
      'utf8',
    )
    .digest('hex');
}

export function calculateVerificationCheckRegistryFingerprint(
  descriptors: readonly VerificationCheckDescriptor[],
): string {
  const canonical = [...descriptors]
    .map((descriptor) => ({
      id: descriptor.id,
      evidenceKind: descriptor.evidenceKind,
      handlerVersion: descriptor.handlerVersion,
      executionClass: descriptor.executionClass,
      handlerFingerprint: calculateVerificationCheckHandlerFingerprint(descriptor),
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return createHash('sha256')
    .update(JSON.stringify({ schemaVersion: 1, checks: canonical }), 'utf8')
    .digest('hex');
}

export function createVerificationCheckBinding(
  registryFingerprint: string,
  descriptor: VerificationCheckDescriptor,
): VerificationCheckBindingV1 {
  if (!SHA256_HEX.test(registryFingerprint)) {
    throw new Error('Verification check registry fingerprint is invalid.');
  }
  const binding = {
    schemaVersion: VERIFICATION_CHECK_BINDING_SCHEMA_VERSION,
    registryFingerprint,
    checkId: descriptor.id,
    evidenceKind: descriptor.evidenceKind,
    handlerVersion: descriptor.handlerVersion,
    executionClass: descriptor.executionClass,
    handlerFingerprint: calculateVerificationCheckHandlerFingerprint(descriptor),
  };
  if (!isVerificationCheckBindingIntegrityValid(binding)) {
    throw new Error('Verification check descriptor cannot produce a valid binding.');
  }
  return Object.freeze(binding);
}

export function isVerificationCheckBindingIntegrityValid(
  binding: VerificationCheckBindingV1,
): boolean {
  try {
    return (
      binding.schemaVersion === VERIFICATION_CHECK_BINDING_SCHEMA_VERSION &&
      SHA256_HEX.test(binding.registryFingerprint) &&
      CHECK_ID.test(binding.checkId) &&
      EVIDENCE_KINDS.includes(binding.evidenceKind) &&
      HANDLER_VERSION.test(binding.handlerVersion) &&
      binding.executionClass === 'trusted_deterministic' &&
      SHA256_HEX.test(binding.handlerFingerprint) &&
      calculateVerificationCheckHandlerFingerprint({
        id: binding.checkId,
        evidenceKind: binding.evidenceKind,
        handlerVersion: binding.handlerVersion,
        executionClass: binding.executionClass,
      }) === binding.handlerFingerprint
    );
  } catch {
    return false;
  }
}

export function verificationCheckBindingMatches(
  binding: VerificationCheckBindingV1,
  registryFingerprint: string,
  descriptor: VerificationCheckDescriptor,
): boolean {
  return (
    isVerificationCheckBindingIntegrityValid(binding) &&
    binding.registryFingerprint === registryFingerprint &&
    binding.checkId === descriptor.id &&
    binding.evidenceKind === descriptor.evidenceKind &&
    binding.handlerVersion === descriptor.handlerVersion &&
    binding.executionClass === descriptor.executionClass &&
    binding.handlerFingerprint === calculateVerificationCheckHandlerFingerprint(descriptor)
  );
}
