import type { MemoryStore } from '@wrongstack/core/types';
import type { SageServiceLike } from './service-contract.js';

const SAGE_METHODS = [
  'retrieveForPath',
  'searchSage',
  'graphFor',
  'verify',
  'hygiene',
  'listCandidates',
  'createCandidate',
  'resolveCandidate',
  'acceptCandidate',
  'rejectCandidate',
  'rememberSage',
  'updateSage',
  'deleteSage',
  'recoverSage',
  'backfillRecoverable',
  'findMemoriesForFile',
  'getSage',
  'unifiedSearchService',
  'listSagePage',
] as const satisfies readonly (keyof SageServiceLike)[];

/** Canonical capability guard used before exposing the SAGE tool set. */
export function isSageService(value: MemoryStore): value is SageServiceLike {
  const candidate = value as unknown as Record<string, unknown>;
  return SAGE_METHODS.every((method) => typeof candidate[method] === 'function');
}
