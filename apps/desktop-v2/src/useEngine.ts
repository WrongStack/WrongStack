import { useCallback, useRef, useSyncExternalStore } from 'react';
import { type BackendScope, backendStream } from './engine-stream';

export function useEngine(id: string, onError: (error: unknown) => void) {
  return useBackend('engine', id, onError);
}
export function useProjectEngine(id: string, onError: (error: unknown) => void) {
  return useBackend('project', id, onError);
}
export function useProfileEngine(onError: (error: unknown) => void) {
  return useBackend('profile', '', onError);
}
function useBackend(scope: BackendScope, id: string, onError: (error: unknown) => void) {
  const stream = backendStream(scope, id);
  const report = useRef(onError);
  report.current = onError;
  const subscribe = useCallback(
    (changed: () => void) =>
      stream.subscribe({ changed, onError: (error) => report.current(error) }),
    [stream],
  );
  const state = useSyncExternalStore(subscribe, () => stream.state);
  return { state, send: stream.send, command: stream.operations.request };
}
