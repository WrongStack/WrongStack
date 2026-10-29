import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import type { FormDraftSnapshot, FormDraftStorage } from './durable-form-draft';
import type { FileDraftSnapshot, FileDraftStorage } from './file-draft';
import type { Snapshot } from './model';
import type {
  ProjectFormDraftStorage,
  RequirementDraftSnapshot,
  RequirementDraftStorage,
} from './requirement-draft';
import type { RequirementRecordDraft } from './requirement-record-draft';

export const native = isTauri();
export const request = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
  if (!native)
    return Promise.reject(
      new Error('Open the Tauri desktop to connect to your local WrongStack engine.'),
    );
  return invoke<T>('host_request', { method, params });
};
const projectWindow = new URLSearchParams(location.search).get('project');
export const layoutKey = projectWindow ? `layout:${projectWindow}` : 'layout';
export const getSnapshot = (): Promise<Snapshot> => request('snapshot', { layoutKey });
export function fileDraftStorage(projectId: string): FileDraftStorage {
  return {
    get: (formKey) => request<FileDraftSnapshot>('form-draft.get', { projectId, formKey }),
    save: (formKey, value, expectedRevision) =>
      request<{ revision: number }>('form-draft.save', {
        projectId,
        formKey,
        value,
        expectedRevision,
      }).then((result) => result.revision),
  };
}
/** Revision-checked storage for one native project form. */
export function projectFormDraftStorage(projectId: string, formKey: string): FormDraftStorage {
  return {
    get: () => request<FormDraftSnapshot>('form-draft.get', { projectId, formKey }),
    save: (value, expectedRevision) =>
      request<{ revision: number }>('form-draft.save', {
        projectId,
        formKey,
        value,
        expectedRevision,
      }).then((result) => result.revision),
  };
}
/**
 * An object part of one desktop session's draft (unsaved model plan or refinement review),
 * revision-checked like the composer draft.
 */
export function sessionObjectDraftStorage(
  sessionId: string,
  part: 'plan' | 'refine',
): FormDraftStorage {
  return {
    get: () => request<FormDraftSnapshot>('draft.object', { id: sessionId, part }),
    save: (value, expectedRevision) =>
      request<{ revision: number }>('draft.save', {
        id: sessionId,
        part,
        text: value === null ? '' : JSON.stringify(value),
        expectedRevision,
      }).then((result) => result.revision),
  };
}
export function requirementDraftStorage(projectId: string): RequirementDraftStorage {
  return {
    get: () =>
      request<RequirementDraftSnapshot>('form-draft.get', {
        projectId,
        formKey: 'requirements-new',
      }),
    save: (value, expectedRevision) =>
      request<{ revision: number }>('form-draft.save', {
        projectId,
        formKey: 'requirements-new',
        value,
        expectedRevision,
      }).then((result) => result.revision),
  };
}
export function requirementRecordDraftStorage(
  projectId: string,
  intakeId: string,
): ProjectFormDraftStorage<RequirementRecordDraft> {
  const formKey = `requirements-record:${intakeId}`;
  return {
    get: () => request<RequirementDraftSnapshot>('form-draft.get', { projectId, formKey }),
    save: (value, expectedRevision) =>
      request<{ revision: number }>('form-draft.save', {
        projectId,
        formKey,
        value,
        expectedRevision,
      }).then((result) => result.revision),
  };
}
export async function addProject(): Promise<void> {
  const root = await invoke<string | null>('choose_project');
  if (root) await request('project.register', { root });
}
export const openProjectWindow = (id: string): Promise<void> =>
  invoke('open_project_window', { id });
/** A private localhost preview window; developer tools open only when asked for. */
export const openPreview = (url: string, devtools = false): Promise<void> =>
  invoke('open_preview', { url, devtools });
export const openExternal = (url: string): Promise<void> => invoke('open_external', { url });
export function streamTerminal(
  id: string,
  onData: (data: Uint8Array, acknowledge: () => void) => void,
  onError: (error: unknown) => void,
): () => void {
  const subscription = crypto.randomUUID();
  const channel = new Channel<ArrayBuffer>();
  let disposed = false;
  channel.onmessage = (bytes) => {
    if (!disposed)
      onData(new Uint8Array(bytes), () => {
        if (!disposed) void invoke('terminal_ack', { subscription }).catch(onError);
      });
  };
  const started = invoke('terminal_stream', { id, subscription, channel });
  void started.catch(onError);
  return () => {
    disposed = true;
    // Wait for registration before cancellation, including React StrictMode's mount/unmount cycle.
    void started.then(() => invoke('terminal_stop', { subscription })).catch(onError);
  };
}
