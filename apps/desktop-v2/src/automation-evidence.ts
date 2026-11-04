import type { AutomationValidation, EnvironmentReceipt } from '@wrongstack/webui-protocol';

/** Each recorded evidence file of a run, and the id its display label is named by. */
export const AUTOMATION_ARTIFACTS = {
  'output.log': 'outputLog',
  'verification.log': 'verificationLog',
  'changes.patch': 'changesPatch',
  'verification.json': 'verificationJson',
  'environment.json': 'environmentJson',
} as const;
export type AutomationArtifact = keyof typeof AUTOMATION_ARTIFACTS;

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const texts = (value: Record<string, unknown>, keys: string[]) =>
  keys.every((key) => typeof value[key] === 'string');
const optionalTexts = (value: Record<string, unknown>, keys: string[]) =>
  keys.every((key) => value[key] === undefined || typeof value[key] === 'string');
const duration = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
function parse(text: string): unknown {
  if (new TextEncoder().encode(text).length > 2 * 1024 * 1024)
    throw Error('Evidence exceeds 2 MiB.');
  return JSON.parse(text);
}
export function parseAutomationVerification(text: string): AutomationValidation {
  const value = parse(text);
  if (
    !object(value) ||
    !texts(value, ['status']) ||
    !['not-verified', 'passed', 'failed', 'stale', 'cancelled'].includes(String(value['status'])) ||
    !strings(value['evidence']) ||
    !optionalTexts(value, ['reason', 'imageId', 'workspaceTree', 'planFingerprint']) ||
    (value['checks'] !== undefined &&
      (!Array.isArray(value['checks']) ||
        !value['checks'].every(
          (check: unknown) =>
            object(check) &&
            strings(check['argv']) &&
            Number.isInteger(check['exitCode']) &&
            duration(check['durationMs']) &&
            texts(check, ['outputSha256']) &&
            object(check['binding']) &&
            texts(check['binding'], [
              'checkId',
              'handlerVersion',
              'handlerFingerprint',
              'registryFingerprint',
            ]) &&
            check['binding']['schemaVersion'] === 1 &&
            check['binding']['executionClass'] === 'trusted_deterministic' &&
            ['test', 'typecheck', 'lint', 'build', 'static_analysis'].includes(
              String(check['binding']['evidenceKind']),
            ),
        )))
  )
    throw Error('Unrecognized verification report.');
  return value as unknown as AutomationValidation;
}
export function parseAutomationEnvironmentReceipt(text: string): EnvironmentReceipt {
  const value = parse(text);
  if (
    !object(value) ||
    value['version'] !== 1 ||
    !texts(value, ['name', 'fingerprint', 'phase', 'status']) ||
    !optionalTexts(value, ['imageId', 'failure']) ||
    !(value['network'] === null || typeof value['network'] === 'string') ||
    !['candidate', 'verification'].includes(String(value['phase'])) ||
    !['preparing', 'ready', 'removed', 'retained', 'unverified'].includes(
      String(value['status']),
    ) ||
    !Array.isArray(value['services']) ||
    !value['services'].every(
      (item: unknown) => object(item) && texts(item, ['name', 'imageId', 'containerId']),
    ) ||
    !Array.isArray(value['caches']) ||
    !value['caches'].every(
      (item: unknown) =>
        object(item) &&
        texts(item, ['name', 'target']) &&
        (item['volume'] === null || typeof item['volume'] === 'string') &&
        typeof item['persistent'] === 'boolean',
    ) ||
    !Array.isArray(value['ports']) ||
    !value['ports'].every(
      (item: unknown) =>
        object(item) &&
        texts(item, ['name']) &&
        Number.isInteger(item['port']) &&
        Number.isInteger(item['hostPort']) &&
        ['http', 'tcp'].includes(String(item['protocol'])),
    ) ||
    !Array.isArray(value['setup']) ||
    !value['setup'].every(
      (item: unknown) =>
        object(item) &&
        strings(item['argv']) &&
        Number.isInteger(item['exitCode']) &&
        duration(item['durationMs']) &&
        texts(item, ['outputSha256', 'output']),
    )
  )
    throw Error('Unrecognized environment receipt.');
  return value as unknown as EnvironmentReceipt;
}
