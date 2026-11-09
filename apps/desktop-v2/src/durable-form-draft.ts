/** A revision-checked native form draft snapshot. */
export interface FormDraftSnapshot {
  revision: number;
  value: unknown;
  updatedAt?: number;
}
export interface FormDraftStorage {
  get(): Promise<FormDraftSnapshot>;
  save(value: unknown, expectedRevision: number): Promise<number>;
}
export interface FormDraftCodec<T> {
  /** Throws for a foreign or unsupported envelope; returns null for an empty slot. */
  parse(value: unknown): T | null;
  serialize(value: T): unknown;
}
export interface DurableFormState<T> {
  value: T | null;
  revision: number;
  updatedAt: number | undefined;
  ready: boolean;
  dirty: boolean;
  saving: boolean;
  error: string;
  /** A newer saved version this window must review before writing again. */
  review: { value: T | null; revision: number } | null;
}

/**
 * Autosaves one form into native storage with compare-and-set revisions. A write
 * that loses to another window stops and asks for review; it never overwrites.
 */
export class DurableFormDraft<T> {
  private state: DurableFormState<T> = {
    value: null,
    revision: 0,
    updatedAt: undefined,
    ready: false,
    dirty: false,
    saving: false,
    error: '',
    review: null,
  };
  private listeners = new Set<() => void>();
  private pending: Promise<void> | null = null;
  private loading: Promise<void> | null = null;
  private blocked = false;
  /** The version whose save failed for a non-conflict reason; the next edit retries it. */
  private failedVersion: number | null = null;
  private version = 0;
  constructor(
    private storage: FormDraftStorage,
    private codec: FormDraftCodec<T>,
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<DurableFormState<T>>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private read(saved: FormDraftSnapshot) {
    if (!Number.isSafeInteger(saved.revision) || saved.revision < 0)
      throw Error('Invalid saved draft revision.');
    return {
      value: this.codec.parse(saved.value),
      revision: saved.revision,
      updatedAt: saved.updatedAt,
    };
  }
  load = (): Promise<void> => {
    if (this.state.ready) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        this.update({ ...this.read(await this.storage.get()), ready: true, error: '' });
      } catch (error) {
        this.update({ error: error instanceof Error ? error.message : String(error) });
      }
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  };
  edit = (value: T | null) => {
    if (!this.state.ready) throw Error('Wait for the saved draft to load.');
    this.version++;
    this.update({ value, dirty: true });
    void this.flush();
  };
  flush = (): Promise<void> => {
    if (this.pending) return this.pending;
    if (!this.state.ready || this.blocked || this.state.review || !this.state.dirty)
      return Promise.resolve();
    this.update({ saving: true });
    this.pending = (async () => {
      while (this.state.dirty && !this.blocked && !this.state.review) {
        const { value, revision } = this.state,
          version = this.version;
        // A transient failure is retried by the next edit, not in a tight loop.
        if (this.failedVersion === version) break;
        try {
          const next = await this.storage.save(
            value === null ? null : this.codec.serialize(value),
            revision,
          );
          if (next !== revision + 1) throw Error('Invalid draft save acknowledgement.');
          this.failedVersion = null;
          this.update({
            revision: next,
            updatedAt: Date.now(),
            dirty: this.version !== version,
            error: '',
          });
        } catch (error) {
          if (String(error).includes('DRAFT_CONFLICT')) {
            this.blocked = true;
            this.update({
              error:
                'This draft is not saved. Your values are kept here; review the saved version.',
            });
            try {
              this.update({ review: this.read(await this.storage.get()) });
            } catch (readError) {
              this.update({ error: String(readError) });
            }
          } else {
            this.failedVersion = version;
            this.update({
              error: `This draft is not saved yet: ${
                error instanceof Error ? error.message : String(error)
              }`,
            });
          }
        }
      }
    })().finally(() => {
      this.pending = null;
      this.update({ saving: false });
      if (
        this.state.dirty &&
        !this.blocked &&
        !this.state.review &&
        this.failedVersion !== this.version
      )
        void this.flush();
    });
    return this.pending;
  };
  /** Keep the local values ("local") or adopt the newer saved version ("saved"). */
  resolve = async (choice: 'local' | 'saved'): Promise<boolean> => {
    await this.pending;
    const review = this.state.review,
      version = this.version;
    if (!review) return false;
    try {
      const latest = this.read(await this.storage.get());
      if (this.version !== version) return false;
      if (latest.revision !== review.revision) {
        this.update({
          review: latest,
          error: 'The saved draft changed again. Review the latest version.',
        });
        return false;
      }
      this.blocked = false;
      this.version++;
      this.update({
        revision: latest.revision,
        review: null,
        error: '',
        ...(choice === 'saved' ? { value: latest.value, dirty: false } : { dirty: true }),
      });
      if (choice === 'local') await this.flush();
      return !this.state.dirty && !this.state.review && !this.state.error;
    } catch (error) {
      this.update({ error: String(error) });
      return false;
    }
  };
  /**
   * Remove the saved draft after its domain write succeeded. Edits made after
   * `expected` was captured are retained instead of being erased.
   */
  clear = async (expected?: T | null): Promise<boolean> => {
    const version = this.version;
    await this.flush();
    if (this.blocked || this.state.review || this.state.dirty) return false;
    if (expected !== undefined && this.state.value !== expected) return false;
    if (version !== this.version) return false;
    const revision = this.state.revision;
    if (this.state.value === null) return true;
    try {
      const next = await this.storage.save(null, revision);
      if (next !== revision + 1) throw Error('Invalid draft clear acknowledgement.');
      if (version !== this.version) {
        this.update({ revision: next, dirty: true });
        await this.flush();
        return false;
      }
      this.version++;
      this.update({ value: null, revision: next, dirty: false, error: '', review: null });
      return true;
    } catch (error) {
      if (String(error).includes('DRAFT_CONFLICT')) {
        this.blocked = true;
        this.update({
          review: this.read(await this.storage.get()),
          error: 'The draft changed in another window before cleanup. Review both versions.',
        });
      } else this.update({ error: String(error) });
      return false;
    }
  };
}
