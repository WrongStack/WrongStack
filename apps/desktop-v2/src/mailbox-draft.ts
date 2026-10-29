import { DurableFormDraft, type FormDraftCodec, type FormDraftStorage } from './durable-form-draft';
import { emptyMailDraft, hasMailDraft, type MailDraft } from './mailbox-model';

const FIELDS = ['to', 'type', 'audience', 'priority', 'subject', 'body', 'replyTo'] as const;
const MAX_BODY = 200_000;
const MAX_FIELD = 2_000;

/** Versioned native envelope for one project's unsent mailbox message. */
export const mailDraftCodec: FormDraftCodec<MailDraft> = {
  serialize: (draft) => ({ version: 1, draft: { ...draft } }),
  parse: (value) => {
    if (value === null) return null;
    const saved = (value ?? {}) as Record<string, unknown>;
    const draft = saved['draft'] as Record<string, unknown> | undefined;
    if (
      saved['version'] !== 1 ||
      !draft ||
      typeof draft !== 'object' ||
      Array.isArray(draft) ||
      Object.keys(draft).some((key) => !(FIELDS as readonly string[]).includes(key)) ||
      !FIELDS.every(
        (field) =>
          typeof draft[field] === 'string' &&
          (draft[field] as string).length <= (field === 'body' ? MAX_BODY : MAX_FIELD),
      )
    )
      throw Error('The saved mailbox draft has an unsupported format.');
    return Object.fromEntries(
      FIELDS.map((field) => [field, String(draft[field])]),
    ) as unknown as MailDraft;
  },
};

/**
 * Project-owned draft; sends retain ownership across component replacement. With native
 * storage the unsent message also survives a restart, and is removed only after the engine
 * confirms the send or the user discards it.
 */
export class MailboxDraftStore {
  private state = {
    draft: emptyMailDraft(),
    pending: false,
    error: '',
    /** When a draft from an earlier window was restored into this one. */
    restoredAt: undefined as number | undefined,
  };
  private listeners = new Set<() => void>();
  private hydrating: Promise<void> | null = null;
  constructor(readonly durable?: DurableFormDraft<MailDraft>) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<typeof this.state>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private persist(draft: MailDraft) {
    const durable = this.durable?.snapshot();
    if (!this.durable || !durable?.ready || durable.review) return;
    const next = hasMailDraft(draft) ? draft : null;
    if (next !== durable.value) this.durable.edit(next);
  }
  /** Load the saved draft once; an empty window adopts it, a typed one keeps its own. */
  hydrate = (): Promise<void> => {
    if (!this.durable) return Promise.resolve();
    this.hydrating ??= this.durable.load().then(() => {
      const saved = this.durable!.snapshot();
      if (!saved.ready) return;
      if (saved.value && !hasMailDraft(this.state.draft) && !this.state.pending)
        this.publish({ draft: saved.value, restoredAt: saved.updatedAt ?? Date.now() });
      else this.persist(this.state.draft);
    });
    return this.hydrating;
  };
  update = (draft: MailDraft) => {
    if (this.state.pending) return;
    this.publish({ draft, error: '', ...(hasMailDraft(draft) ? {} : { restoredAt: undefined }) });
    this.persist(draft);
  };
  /** Adopt the version another window saved ("saved") or keep this window's ("local"). */
  resolve = async (choice: 'local' | 'saved') => {
    const ok = (await this.durable?.resolve(choice)) ?? false;
    if (ok && choice === 'saved')
      this.publish({ draft: this.durable!.snapshot().value ?? emptyMailDraft(), error: '' });
    // Edits typed while the review was open were not saved yet.
    else if (ok) this.persist(this.state.draft);
    return ok;
  };
  /**
   * Resolve an other-window conflict with a body merged change by change; this window's other
   * fields (recipients, subject…) are kept, and the result becomes the saved draft.
   */
  merge = async (body: string) => {
    if (this.state.pending) return false;
    this.publish({ draft: { ...this.state.draft, body }, error: '' });
    return this.resolve('local');
  };
  begin() {
    if (this.state.pending) throw Error('A mailbox send is already awaiting acknowledgement.');
    const submitted = this.state.draft;
    this.publish({ pending: true, error: '' });
    return submitted;
  }
  acknowledge(submitted: MailDraft) {
    const sent = this.state.draft === submitted;
    this.publish({
      pending: false,
      ...(sent ? { draft: emptyMailDraft(), restoredAt: undefined } : {}),
    });
    // The engine confirmed the message, so its saved copy can go; newer edits are kept.
    if (sent) void this.durable?.clear(submitted);
  }
  fail(error: unknown) {
    this.publish({
      pending: false,
      error: `${error instanceof Error ? error.message : String(error)} Check recent mailbox messages before retrying; delivery may already have been recorded.`,
    });
  }
}
const stores = new Map<string, MailboxDraftStore>();
/** One store per project in this window; `storage` makes the draft durable. */
export function mailboxDraftStore(projectId: string, storage?: FormDraftStorage) {
  let store = stores.get(projectId);
  if (!store) {
    store = new MailboxDraftStore(
      storage ? new DurableFormDraft(storage, mailDraftCodec) : undefined,
    );
    stores.set(projectId, store);
  }
  return store;
}
