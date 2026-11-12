import { DurableFormDraft, type FormDraftCodec } from './durable-form-draft';
import type { InputDraft } from './input-form-model';
import { projectFormDraftStorage } from './platform';

export interface InputAnswerOwner {
  projectId: string;
  sessionId: string;
  requestId: string;
}
const ownerKey = (owner: InputAnswerOwner) =>
  JSON.stringify([owner.projectId, owner.sessionId, owner.requestId]);
export async function inputAnswerDraftKey(owner: InputAnswerOwner) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ownerKey(owner)));
  return `input-answers:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}
export function inputAnswerCodec(owner: InputAnswerOwner): FormDraftCodec<InputDraft> {
  return {
    serialize: (answers) => ({ version: 1, owner: ownerKey(owner), answers }),
    parse: (value) => {
      if (value === null) return null;
      const saved = (value ?? {}) as Record<string, unknown>;
      const answers = saved['answers'];
      if (
        saved['version'] !== 1 ||
        saved['owner'] !== ownerKey(owner) ||
        !answers ||
        typeof answers !== 'object' ||
        Array.isArray(answers) ||
        !Object.values(answers).every((answer) => {
          if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false;
          const item = answer as Record<string, unknown>;
          return (
            typeof item['text'] === 'string' &&
            typeof item['delegated'] === 'boolean' &&
            Array.isArray(item['selectedOptionIds']) &&
            item['selectedOptionIds'].every((id) => typeof id === 'string')
          );
        })
      )
        throw Error(
          'Saved question answers have an unsupported format or belong to another request.',
        );
      return structuredClone(answers) as InputDraft;
    },
  };
}
const drafts = new Map<string, DurableFormDraft<InputDraft>>();
/** One revision-checked native draft per project, desktop session and engine request. */
export function inputAnswerDraft(owner: InputAnswerOwner) {
  const key = ownerKey(owner);
  let draft = drafts.get(key);
  if (!draft) {
    const formKey = inputAnswerDraftKey(owner);
    draft = new DurableFormDraft(
      {
        get: async () => projectFormDraftStorage(owner.projectId, await formKey).get(),
        save: async (value, revision) =>
          projectFormDraftStorage(owner.projectId, await formKey).save(value, revision),
      },
      inputAnswerCodec(owner),
    );
    drafts.set(key, draft);
  }
  return draft;
}
/** Only an acknowledged resolution may retire that request's saved answers. */
export async function clearInputAnswerDraft(owner: InputAnswerOwner) {
  const draft = inputAnswerDraft(owner);
  await draft.load();
  if (!draft.snapshot().ready || !(await draft.clear()))
    throw Error(draft.snapshot().error || 'Saved question answers could not be cleared.');
  if (drafts.get(ownerKey(owner)) === draft) drafts.delete(ownerKey(owner));
}
