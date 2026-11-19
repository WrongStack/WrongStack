import { record } from './engine-values';
import {
  type ModelEditorDraft,
  modelFlags,
  modelNumberFields,
  modelTextFields,
} from './model-catalog-editor';
import { sameSetting } from './settings-save-model';

export interface ModelEditorState {
  originalId: string;
  initial: Record<string, unknown> | undefined;
  draft: ModelEditorDraft;
  baseline: ModelEditorDraft;
}
export interface SavedModelEditor {
  version: 1;
  providerId: string;
  profileId?: string;
  /** Display name when saved; ownership is `profileId` alone. */
  profileName?: string;
  editor: ModelEditorState;
}
export interface ModelDraftSnapshot {
  revision: number;
  value: unknown;
  updatedAt?: number;
}
export interface ModelDraftStorage {
  get(): Promise<ModelDraftSnapshot>;
  save(value: SavedModelEditor | null, revision: number): Promise<number>;
}
function validDraft(value: unknown): value is ModelEditorDraft {
  const draft = record(value),
    advanced = record(draft['advanced']),
    runtime = record(advanced['runtime']),
    pricing = record(draft['pricing']);
  const strings = (value: unknown) =>
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((value) => typeof value === 'string');
  const list = (value: unknown) =>
    Array.isArray(value) && value.every((value) => typeof value === 'string');
  return (
    ['id', 'input', 'output'].every((key) => typeof draft[key] === 'string') &&
    ['text', 'numbers', 'flags'].every((key) => strings(draft[key])) &&
    modelTextFields.every(([key]) => typeof record(draft['text'])[key] === 'string') &&
    modelNumberFields.every(
      ([group, key]) => typeof record(draft['numbers'])[`${group}.${key}`] === 'string',
    ) &&
    modelFlags.every(([key]) =>
      ['inherit', 'true', 'false'].includes(String(record(draft['flags'])[key])),
    ) &&
    ['status', 'experimental', 'npm', 'api', 'interleaved', 'field', 'runtimePolicy'].every(
      (key) => typeof advanced[key] === 'string',
    ) &&
    ['preserve', 'catalog', 'custom'].includes(String(advanced['runtimePolicy'])) &&
    typeof runtime['disableSupported'] === 'boolean' &&
    ['default', 'effortSupported', 'preserveThinking'].every(
      (key) => typeof runtime[key] === 'string',
    ) &&
    list(runtime['effortLevels']) &&
    Array.isArray(advanced['options']) &&
    advanced['options'].every((option) => {
      const row = record(option);
      return (
        ['type', 'min', 'max'].every((key) => typeof row[key] === 'string') &&
        list(row['values']) &&
        !!row['source'] &&
        typeof row['source'] === 'object' &&
        !Array.isArray(row['source'])
      );
    }) &&
    typeof pricing['changed'] === 'boolean' &&
    typeof pricing['unsupported'] === 'boolean' &&
    Array.isArray(pricing['rows']) &&
    pricing['rows'].every((row) => {
      const tier = record(row);
      return (
        typeof tier['size'] === 'string' &&
        typeof tier['editable'] === 'boolean' &&
        strings(tier['prices'])
      );
    })
  );
}
export function parseModelEditor(
  value: unknown,
  providerId: string,
  profileId?: string,
): ModelEditorState | null {
  if (value === null) return null;
  const saved = record(value),
    editor = record(saved['editor']);
  if (
    saved['version'] !== 1 ||
    saved['providerId'] !== providerId ||
    (profileId !== undefined && saved['profileId'] !== profileId) ||
    typeof editor['originalId'] !== 'string' ||
    (editor['initial'] !== undefined &&
      (!editor['initial'] ||
        typeof editor['initial'] !== 'object' ||
        Array.isArray(editor['initial']))) ||
    !validDraft(editor['draft']) ||
    !validDraft(editor['baseline'])
  )
    throw Error(
      'Saved model draft has an unsupported format or belongs to another provider or profile.',
    );
  return structuredClone(editor) as unknown as ModelEditorState;
}

export class ModelEditorDraftStore {
  private state = {
    value: null as ModelEditorState | null,
    revision: 0,
    ready: false,
    dirty: false,
    saving: false,
    error: '',
    review: null as { value: ModelEditorState | null; revision: number } | null,
  };
  private listeners = new Set<() => void>();
  private pending: Promise<void> | null = null;
  private loading: Promise<void> | null = null;
  private blocked = false;
  private version = 0;
  constructor(
    private storage: ModelDraftStorage,
    private providerId: string,
    private profileId?: string,
    private profileName?: string,
  ) {}
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
  private read(saved: ModelDraftSnapshot) {
    if (!Number.isSafeInteger(saved.revision) || saved.revision < 0)
      throw Error('Invalid model draft revision.');
    return {
      value: parseModelEditor(saved.value, this.providerId, this.profileId),
      revision: saved.revision,
    };
  }
  load = (): Promise<void> => {
    if (this.state.ready) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const saved = this.read(await this.storage.get());
        this.update({ ...saved, ready: true, error: '' });
      } catch (error) {
        this.update({ error: String(error) });
      }
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  };
  edit = (value: ModelEditorState) => {
    if (!this.state.ready) throw Error('Wait for the saved model draft to load.');
    const valid = parseModelEditor(
      {
        version: 1,
        providerId: this.providerId,
        ...(this.profileId ? { profileId: this.profileId } : {}),
        editor: value,
      },
      this.providerId,
      this.profileId,
    );
    this.version++;
    this.update({ value: valid, dirty: true });
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
        try {
          const next = await this.storage.save(
            value
              ? {
                  version: 1,
                  providerId: this.providerId,
                  ...(this.profileId ? { profileId: this.profileId } : {}),
                  ...(this.profileId && this.profileName ? { profileName: this.profileName } : {}),
                  editor: value,
                }
              : null,
            revision,
          );
          if (next !== revision + 1) throw Error('Invalid model draft acknowledgement.');
          this.update({ revision: next, dirty: this.version !== version, error: '' });
        } catch (error) {
          this.blocked = true;
          this.update({
            error:
              'This model draft is not saved. Local edits are kept. Compare the saved draft before retrying.',
          });
          if (String(error).includes('DRAFT_CONFLICT')) {
            try {
              this.update({ review: this.read(await this.storage.get()) });
            } catch (readError) {
              this.update({ error: String(readError) });
            }
          }
        }
      }
    })().finally(() => {
      this.pending = null;
      this.update({ saving: false });
      if (this.state.dirty && !this.blocked && !this.state.review) void this.flush();
    });
    return this.pending;
  };
  compare = async () => {
    await this.pending;
    try {
      this.update({ review: this.read(await this.storage.get()) });
    } catch (error) {
      this.update({ error: String(error) });
    }
  };
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
          error: 'The saved model draft changed again. Review the latest version.',
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
  prepare = async (expected?: ModelEditorState) => {
    const version = this.version;
    await this.flush();
    if (
      !this.state.ready ||
      this.blocked ||
      this.state.dirty ||
      this.state.review ||
      version !== this.version
    )
      throw Error('Resolve model draft storage before applying this definition.');
    if (expected && !sameSetting(expected, this.state.value))
      throw Error('The editor changed while preparing to apply. Review the current model draft.');
    const saved = this.read(await this.storage.get());
    if (saved.revision !== this.state.revision) {
      this.blocked = true;
      this.update({
        review: saved,
        error: 'The saved model draft changed before applying. Review both versions.',
      });
      throw Error('The saved model draft changed before applying. Review both versions.');
    }
    if (version !== this.version) throw Error('The model draft changed while preparing to save.');
  };
  clear = async () => {
    await this.prepare();
    const version = this.version,
      revision = this.state.revision;
    try {
      const next = await this.storage.save(null, revision);
      if (next !== revision + 1) throw Error('Invalid model draft clear acknowledgement.');
      if (version !== this.version) {
        this.update({ revision: next, dirty: true });
        await this.flush();
        throw Error('Newer local model edits were retained instead of closing the editor.');
      }
      this.version++;
      this.update({ value: null, revision: next, dirty: false, error: '', review: null });
    } catch (error) {
      if (String(error).includes('DRAFT_CONFLICT')) {
        this.blocked = true;
        this.update({
          error:
            'The draft changed before cleanup. Review both versions before closing the editor.',
        });
        await this.compare();
      }
      throw error;
    }
  };
}
