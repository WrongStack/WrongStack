export type {
  IncrementalUpdateStrategy,
  StructuralChangeKind,
  StructuralRefInput,
  StructuralSymbolInput,
  SymbolLossValidationResult,
} from '@wrongstack/codebase/fingerprint';
export {
  classifyFileChange,
  classifyIncrementalUpdateStrategy,
  classifySymbolBodyDrift,
  computeFileStructuralFingerprint,
  computeFileStructuralFingerprintWithStatement,
  computeStructuralFingerprint,
  hasDynamicSymbolInjection,
  validateIncrementalSymbolLoss,
} from '@wrongstack/codebase/fingerprint';
