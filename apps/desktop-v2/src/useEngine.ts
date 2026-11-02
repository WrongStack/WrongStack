import { decodeProtocolMessage } from '@wrongstack/webui-protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { EngineOperations } from './engine-operations';
import { emptyEngineState, engineEvent, replayEngineBatch } from './engine-state';
import { request } from './platform';

export function useEngine(id: string, onError: (error: unknown) => void) {
  return useBackend('engine', id, onError);
}
export function useProjectEngine(id: string, onError: (error: unknown) => void) {
  return useBackend('project', id, onError);
}
export function useProfileEngine(onError: (error: unknown) => void) {
  return useBackend('profile', '', onError);
}
function useBackend(
  scope: 'engine' | 'project' | 'profile',
  id: string,
  onError: (error: unknown) => void,
) {
  const [state, setState] = useState({ ...emptyEngineState, hydrating: true });
  const send = useCallback(
    async (type: string, payload: Record<string, unknown> = {}) => {
      const message = { type, payload };
      const decoded = decodeProtocolMessage(message, 'client');
      if (!decoded.ok) throw new Error(decoded.issue.message);
      await request(`${scope}.send`, {
        ...(scope === 'project' ? { projectId: id } : { id }),
        message,
      });
    },
    [id, scope],
  );
  const operations = useMemo(() => new EngineOperations(send), [send]);
  useEffect(() => {
    let stopped = false;
    let offset = 0;
    let timer: ReturnType<typeof setTimeout>;
    setState({ ...emptyEngineState, hydrating: true });
    operations.replaying();
    const poll = async () => {
      try {
        const result = await request<{ offset: number; events: unknown[]; hasMore?: boolean }>(
          `${scope}.events`,
          {
            ...(scope === 'project' ? { projectId: id } : { id }),
            offset,
          },
        );
        if (stopped) return;
        const hasMore =
          result.hasMore ?? (result.events.length === 200 || result.offset - offset >= 262144);
        offset = result.offset;
        const events = result.events.map(engineEvent).filter((event) => event !== null);
        for (const event of events) operations.receive(event);
        if (!hasMore) operations.caughtUp();
        if (scope === 'engine' && events.some((event) => event.type === 'run.result'))
          void send('stats.get').catch(onError);
        setState((current) => replayEngineBatch(current, events, hasMore));
        timer = setTimeout(poll, hasMore ? 0 : 100);
      } catch (error) {
        if (!stopped) {
          onError(error);
          timer = setTimeout(poll, 1000);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      operations.clear();
    };
  }, [id, scope, onError, operations, send]);
  return { state, send, command: operations.request };
}
