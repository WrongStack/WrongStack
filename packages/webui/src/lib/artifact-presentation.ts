import { parseArtifactPresentation } from '@wrongstack/tools/artifact-presentation';
import { useFileStore, useUIStore } from '@/stores';
import { getWSClient } from './ws-client';
import { foregroundSessionId } from './ws-client-utils';

const seen = new Set<string>();
const pending = new Map<string, { sessionId: string; path: string; at: number }>();
const PREFIX = 'artifact:';
let browserTarget: { sessionId: string; id: string } | null = null;
export function presentedBrowserId(sessionId: string | null): string | undefined {
  return browserTarget?.sessionId === sessionId ? browserTarget.id : undefined;
}

export function presentArtifactResult(
  name: string,
  ok: boolean,
  output: unknown,
  sessionId: string,
): void {
  if (name !== 'present_artifact' || !ok || foregroundSessionId() !== sessionId) return;
  const artifact = parseArtifactPresentation(output);
  if (!artifact || artifact.sessionId !== sessionId || seen.has(artifact.id)) return;
  seen.add(artifact.id);
  if (seen.size > 128) seen.delete(seen.values().next().value!);
  if (!['chat', 'files'].includes(useUIStore.getState().currentView)) return;
  if (artifact.kind === 'browser') {
    browserTarget = { sessionId, id: artifact.browserSessionId! };
    useUIStore.getState().showDockChip('browser');
    useUIStore.getState().setDockSection('browser');
    window.dispatchEvent(
      new CustomEvent('wrongstack:present-browser', {
        detail: { sessionId, id: artifact.browserSessionId },
      }),
    );
    return;
  }
  if (artifact.kind === 'image' || artifact.kind === 'diff') {
    window.dispatchEvent(new CustomEvent('wrongstack:rich-artifact', { detail: artifact }));
    return;
  }
  const store = useFileStore.getState();
  const files =
    store.fileSessionId === sessionId
      ? store.openFiles
      : store.filesBySession[sessionId]?.openFiles;
  if (files?.some((file) => file.path === artifact.path)) {
    store.setActiveFile(artifact.path, sessionId);
    useUIStore.getState().setCurrentView('files');
    return;
  }
  const requestId = `${PREFIX}${artifact.id}`;
  pending.set(requestId, { sessionId, path: artifact.path, at: Date.now() });
  if (pending.size > 64) pending.delete(pending.keys().next().value!);
  const payload = { filePath: artifact.path, sessionId, requestId };
  getWSClient()?.send({ type: 'files.read', payload });
}

/** Consume only correlated reads; late replies must not replace edits or steal focus. */
export function consumeArtifactRead(payload: Record<string, unknown>): boolean {
  const requestId = payload?.['requestId'];
  if (typeof requestId !== 'string' || !requestId.startsWith(PREFIX)) return false;
  const request = pending.get(requestId);
  pending.delete(requestId);
  if (
    !request ||
    Date.now() - request.at > 30_000 ||
    payload['sessionId'] !== request.sessionId ||
    payload['filePath'] !== request.path
  )
    return true;
  if (foregroundSessionId() !== request.sessionId) return true;
  const store = useFileStore.getState();
  if (payload['error'] || payload['binary'] || payload['tooLarge']) {
    store.setError(
      typeof payload['error'] === 'string'
        ? payload['error']
        : 'Artifact cannot be displayed as text.',
      request.sessionId,
    );
    return true;
  }
  if (typeof payload['content'] !== 'string') return true;
  const files =
    store.fileSessionId === request.sessionId
      ? store.openFiles
      : store.filesBySession[request.sessionId]?.openFiles;
  if (files?.some((file) => file.path === request.path))
    store.setActiveFile(request.path, request.sessionId);
  else store.openFile(request.path, payload['content'], request.sessionId);
  if (['chat', 'files'].includes(useUIStore.getState().currentView))
    useUIStore.getState().setCurrentView('files');
  return true;
}
