import type { ProjectFormDraftStorage } from './requirement-draft';

export interface ReviewReply {
  text: string;
  /** ISO time the reply was added on this desktop. */
  at: string;
}
export interface ReviewNote {
  path: string;
  line: number;
  text: string;
  resolved?: boolean;
  replies?: ReviewReply[];
}
/** Version 1 notes have no discussion; they still load and are saved back as version 2. */
export interface SavedReviewNotes {
  version: 1 | 2;
  notes: ReviewNote[];
}
export const MAX_REVIEW_REPLIES = 50;
const validReply = (reply: unknown) => {
  const value = reply as Partial<ReviewReply> | null;
  return (
    !!value &&
    typeof value.text === 'string' &&
    !!value.text.trim() &&
    typeof value.at === 'string' &&
    !Number.isNaN(Date.parse(value.at))
  );
};
export function parseReviewNotes(value: unknown): ReviewNote[] {
  if (value === null) return [];
  const data = value as Partial<SavedReviewNotes> | undefined;
  const version = data?.version;
  if (
    (version !== 1 && version !== 2) ||
    !Array.isArray(data?.notes) ||
    data.notes.length > 500 ||
    data.notes.some(
      (note) =>
        !note ||
        typeof note.path !== 'string' ||
        !note.path ||
        !Number.isSafeInteger(note.line) ||
        note.line < 1 ||
        typeof note.text !== 'string' ||
        !note.text.trim() ||
        (version === 1 && (note.resolved !== undefined || note.replies !== undefined)) ||
        (note.resolved !== undefined && typeof note.resolved !== 'boolean') ||
        (note.replies !== undefined &&
          (!Array.isArray(note.replies) ||
            note.replies.length > MAX_REVIEW_REPLIES ||
            !note.replies.every(validReply))),
    )
  )
    throw Error('Saved review notes have an unsupported format.');
  return data.notes.map((note) => ({
    path: note.path,
    line: note.line,
    text: note.text,
    ...(note.resolved ? { resolved: true } : {}),
    ...(note.replies?.length
      ? { replies: note.replies.map((reply) => ({ text: reply.text, at: reply.at })) }
      : {}),
  }));
}
export class ReviewNotesStore {
  private state = { notes: [] as ReviewNote[], revision: 0, ready: false, busy: false, error: '' };
  private listeners = new Set<() => void>();
  constructor(
    private storage: ProjectFormDraftStorage<SavedReviewNotes>,
    private initial: ReviewNote[] = [],
  ) {
    this.state = { ...this.state, notes: initial };
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<typeof this.state>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  load = async () => {
    if (this.state.busy) return;
    this.update({ busy: true, error: '' });
    try {
      const saved = await this.storage.get();
      const notes = saved.value === null ? this.initial : parseReviewNotes(saved.value);
      let revision = saved.revision;
      if (saved.value === null && notes.length) {
        const value: SavedReviewNotes = { version: 2, notes };
        parseReviewNotes(value);
        revision = await this.storage.save(value, revision);
      }
      this.update({
        notes,
        revision,
        ready: true,
      });
    } catch (error) {
      this.update({ error: String(error), ready: false });
    } finally {
      this.update({ busy: false });
    }
  };
  save = async (notes: ReviewNote[]) => {
    if (!this.state.ready || this.state.busy)
      throw Error('Wait for review notes to finish loading or saving.');
    const value: SavedReviewNotes = { version: 2, notes };
    parseReviewNotes(value);
    this.update({ busy: true, error: '' });
    try {
      const revision = await this.storage.save(value, this.state.revision);
      this.initial = [];
      this.update({ notes, revision });
    } catch (error) {
      this.update({
        error:
          'Review notes were not saved. Another window may have changed them. Reload saved review notes before retrying.',
      });
      throw error;
    } finally {
      this.update({ busy: false });
    }
  };
}

/** Notes with one reply appended to the note at `index`; refuses past the reply limit. */
export function withReply(notes: ReviewNote[], index: number, text: string, at: string) {
  const note = notes[index];
  if (!note || !text.trim()) return notes;
  const replies = note.replies ?? [];
  if (replies.length >= MAX_REVIEW_REPLIES)
    throw Error(`A review note keeps at most ${MAX_REVIEW_REPLIES} replies.`);
  return notes.map((item, i) =>
    i === index ? { ...item, replies: [...replies, { text: text.trim(), at }] } : item,
  );
}
export function withResolved(notes: ReviewNote[], index: number, resolved: boolean) {
  return notes.map((item, i) => {
    if (i !== index) return item;
    const { resolved: _, ...rest } = item;
    return resolved ? { ...rest, resolved: true } : rest;
  });
}
