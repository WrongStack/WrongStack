import type { EnvironmentDraft } from './automation-environment-model';
import type { FormDraftCodec } from './durable-form-draft';

/** Unapplied environment dialog edits and the environment they were made from. */
export interface SavedEnvironmentDraft {
  base: EnvironmentDraft;
  draft: EnvironmentDraft;
}

const MAX_BYTES = 512 * 1024;
const MAX_ROWS = 100;

/** One native slot per job (or the new automation), so jobs never overwrite each other. */
export async function environmentDraftKey(projectId: string, jobId: string | undefined) {
  const source = JSON.stringify(['automation-environment', projectId, jobId ?? '@new']);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return `automation-environment:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: Record<string, unknown>, keys: readonly string[]) =>
  keys.every((key) => typeof value[key] === 'string');
const rows = (value: unknown, valid: (row: Record<string, unknown>) => boolean) =>
  Array.isArray(value) &&
  value.length <= MAX_ROWS &&
  value.every((row) => isRecord(row) && valid(row));

function environmentDraftShape(value: unknown): value is EnvironmentDraft {
  return (
    isRecord(value) &&
    strings(value, ['name', 'image', 'setup', 'timeoutSeconds']) &&
    rows(value['services'], (row) =>
      strings(row, ['name', 'image', 'command', 'health', 'envNames']),
    ) &&
    rows(value['caches'], () => true) &&
    rows(
      value['ports'],
      (row) =>
        strings(row, ['name', 'port']) && (row['protocol'] === 'http' || row['protocol'] === 'tcp'),
    )
  );
}

export const environmentDraftCodec: FormDraftCodec<SavedEnvironmentDraft> = {
  serialize: (saved) => ({ version: 1, ...saved }),
  parse: (value) => {
    if (value === null) return null;
    const saved = value as Record<string, unknown>;
    if (
      !isRecord(saved) ||
      saved['version'] !== 1 ||
      JSON.stringify(saved).length > MAX_BYTES ||
      !environmentDraftShape(saved['base']) ||
      !environmentDraftShape(saved['draft'])
    )
      throw Error('The saved environment draft has an unsupported format.');
    return structuredClone({
      base: saved['base'] as EnvironmentDraft,
      draft: saved['draft'] as EnvironmentDraft,
    });
  },
};
