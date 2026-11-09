import { type ComposerAttachment, validateAttachments } from './composer-attachments';
import type { SubmitMode } from './composer-model';
import {
  type ComposerFileReference,
  validReferenceLines,
  validSnippet,
} from './composer-resources-model';

export type DraftRevisions = Record<'text' | 'references' | 'attachments' | 'mode', number>;
export interface SavedDraft {
  text: string;
  references: ComposerFileReference[];
  attachments: ComposerAttachment[];
  mode: SubmitMode;
  revisions: DraftRevisions;
}
export function validateSavedDraft(value: SavedDraft): SavedDraft {
  if (typeof value.text !== 'string') throw Error('Saved draft text is invalid.');
  if (
    !Array.isArray(value.references) ||
    value.references.some(
      (ref) =>
        !ref ||
        typeof ref.path !== 'string' ||
        !ref.path ||
        (ref.lines !== undefined && !validReferenceLines(ref.lines)) ||
        (ref.snippet !== undefined && !validSnippet(ref.snippet)),
    )
  )
    throw Error('Saved file references are invalid.');
  if (
    !Array.isArray(value.attachments) ||
    value.attachments.some(
      (item) =>
        !item ||
        typeof item.id !== 'string' ||
        typeof item.name !== 'string' ||
        typeof item.data !== 'string' ||
        typeof item.mediaType !== 'string' ||
        typeof item.bytes !== 'number',
    )
  )
    throw Error('Saved attachments are invalid.');
  validateAttachments(value.attachments);
  if (!['btw', 'queue', 'steer'].includes(value.mode))
    throw Error('Saved delivery mode is invalid.');
  if (
    !value.revisions ||
    ['text', 'references', 'attachments', 'mode'].some(
      (key) =>
        !Number.isSafeInteger(value.revisions[key as keyof DraftRevisions]) ||
        value.revisions[key as keyof DraftRevisions] < 0,
    )
  )
    throw Error('Saved draft revisions are invalid.');
  return value;
}
