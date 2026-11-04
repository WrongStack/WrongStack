import type { ProjectFormDraftStorage } from './requirement-draft';

export interface HistoryView {
  pageSize: number;
  query: string;
  provider: string;
  outcome: string;
  includeEmpty: boolean;
  selectedId: string;
  anchorId: string;
}
export interface SavedHistoryView {
  version: 1;
  view: HistoryView;
}
export const defaultHistoryView = (): HistoryView => ({
  pageSize: 100,
  query: '',
  provider: '',
  outcome: '',
  includeEmpty: false,
  selectedId: '',
  anchorId: '',
});
export function parseHistoryView(value: unknown): HistoryView {
  if (value === null) return defaultHistoryView();
  const saved = value as Partial<SavedHistoryView> | undefined;
  const view = saved?.view;
  if (
    saved?.version !== 1 ||
    !view ||
    ![50, 100, 200].includes(view.pageSize) ||
    typeof view.query !== 'string' ||
    view.query.length > 500 ||
    typeof view.provider !== 'string' ||
    view.provider.length > 1024 ||
    !['', 'open', 'completed', 'error', 'aborted'].includes(view.outcome) ||
    typeof view.includeEmpty !== 'boolean' ||
    [view.selectedId, view.anchorId].some((id) => typeof id !== 'string' || id.length > 1024)
  )
    throw Error('Saved history view has an unsupported format.');
  return {
    pageSize: view.pageSize,
    query: view.query,
    provider: view.provider,
    outcome: view.outcome,
    includeEmpty: view.includeEmpty,
    selectedId: view.selectedId,
    anchorId: view.anchorId,
  };
}
type ViewKey = keyof HistoryView;
export class HistoryViewStore {
  private state = {
    value: defaultHistoryView(),
    ready: false,
    saving: false,
    error: '',
    /** Which failure `error` describes, so a page can word it in the display language. */
    errorKind: '' as '' | 'restore' | 'retry' | 'save',
  };
  private listeners = new Set<() => void>();
  private edits = new Map<ViewKey, HistoryView[ViewKey]>();
  private pending: Promise<void> | null = null;
  private loading: Promise<void> | null = null;
  constructor(private storage: ProjectFormDraftStorage<SavedHistoryView>) {}
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
  load = (): Promise<void> => {
    if (this.state.ready) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        this.update({
          value: parseHistoryView((await this.storage.get()).value),
          ready: true,
          error: '',
        });
      } catch {
        this.update({
          ready: true,
          errorKind: 'restore',
          error:
            'History view could not be restored. You can browse with defaults; view changes may not be saved.',
        });
      }
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  };
  change = (patch: Partial<HistoryView>) => {
    if (!this.state.ready) return;
    const value = parseHistoryView({ version: 1, view: { ...this.state.value, ...patch } });
    let changed = false;
    for (const key of Object.keys(value) as ViewKey[]) {
      if (Object.hasOwn(patch, key)) {
        this.edits.set(key, value[key]);
        changed = true;
      }
    }
    if (!changed) return;
    this.update({ value });
    void this.flush();
  };
  retry = async () => {
    if (this.edits.size) return this.flush();
    try {
      parseHistoryView((await this.storage.get()).value);
      this.update({ error: '' });
    } catch {
      this.update({
        errorKind: 'retry',
        error:
          'History view storage is still unavailable or has an unsupported format. Your current view is retained.',
      });
    }
  };
  flush = (): Promise<void> => {
    if (this.pending) return this.pending;
    if (!this.state.ready || !this.edits.size) return Promise.resolve();
    this.update({ saving: true });
    this.pending = (async () => {
      try {
        while (this.edits.size) {
          const patch = new Map(this.edits);
          let saved = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            const latest = await this.storage.get();
            if (!Number.isSafeInteger(latest.revision) || latest.revision < 0)
              throw Error('Invalid history view revision.');
            const value = parseHistoryView({
              version: 1,
              view: { ...parseHistoryView(latest.value), ...Object.fromEntries(patch) },
            });
            try {
              const revision = await this.storage.save(
                { version: 1, view: value },
                latest.revision,
              );
              if (!Number.isSafeInteger(revision) || revision !== latest.revision + 1)
                throw Error('Invalid history view save acknowledgement.');
              saved = true;
              break;
            } catch (error) {
              if (!String(error).includes('DRAFT_CONFLICT') || attempt === 2) throw error;
            }
          }
          if (!saved) throw Error('History view changed repeatedly.');
          for (const [key, value] of patch)
            if (this.edits.get(key) === value) this.edits.delete(key);
          this.update({ error: '' });
        }
      } catch {
        this.update({
          errorKind: 'save',
          error:
            'History view changes are not saved. Your current view is retained. Retry saving when the native store is available.',
        });
      }
    })().finally(() => {
      this.pending = null;
      this.update({ saving: false });
    });
    return this.pending;
  };
}
