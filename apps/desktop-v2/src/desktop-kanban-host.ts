import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import type { SurfaceClient } from '@wrongstack/project-surfaces/host';
import type {
  KanbanFleetAgent,
  KanbanHost,
  KanbanRunTarget,
  ModelCandidate,
} from '@wrongstack/project-surfaces/kanban/kanban-host';
import type { SurfaceSend } from '@wrongstack/project-surfaces/sage/socket';
import { type ComponentType, useEffect, useMemo, useRef, useState } from 'react';

interface ProviderModelRow {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  outputModalities?: string[];
}

const NO_AGENTS: ReadonlyMap<string, KanbanFleetAgent> = new Map();
const NO_DEFAULT = { provider: '', model: '' };

/**
 * The Kanban host for one desktop project: requests go out on the project connection and
 * replies come back through the surface client. The desktop board is not opened from a
 * conversation, so it stamps no session on its writes; `kanban.meta` names the provider and
 * model a task without its own runs on.
 */
export function desktopKanbanHost({
  client,
  send,
  openRun,
  BoardExtras,
  TaskExtras,
}: {
  client: SurfaceClient;
  send: SurfaceSend;
  openRun?: ((run: KanbanRunTarget) => void) | undefined;
  BoardExtras?: ComponentType<{ board: KanbanBoard }> | undefined;
  TaskExtras?: ComponentType<{ board: KanbanBoard; task: KanbanTask }> | undefined;
}): KanbanHost {
  const request = (type: string, payload?: Record<string, unknown>) =>
    send({ type, payload: payload ?? {} });
  const on: KanbanHost['on'] = (type, handler) =>
    client.on(type, (message) => handler({ payload: message.payload }));

  /** The saved providers and each one's models, asked for while a picker is open. */
  const useModelCandidates = (active: boolean): ModelCandidate[] => {
    const [saved, setSaved] = useState<Array<{ id: string; type?: string | undefined }>>([]);
    const [byProvider, setByProvider] = useState<Record<string, ProviderModelRow[]>>({});
    const requested = useRef(new Set<string>());
    useEffect(() => {
      if (!active) return;
      const offSaved = on('providers.saved', ({ payload }) => {
        const providers = (payload as { providers?: Array<{ id: string; type?: string }> })
          ?.providers;
        if (Array.isArray(providers)) setSaved(providers.map(({ id, type }) => ({ id, type })));
      });
      const offModels = on('provider.models', ({ payload }) => {
        const reply = payload as { provider?: string; models?: ProviderModelRow[] };
        if (typeof reply?.provider === 'string')
          setByProvider((previous) => ({
            ...previous,
            [reply.provider as string]: reply.models ?? [],
          }));
      });
      request('providers.saved');
      return () => {
        offSaved();
        offModels();
      };
    }, [active]);
    useEffect(() => {
      if (!active) return;
      for (const { id } of saved) {
        if (byProvider[id] || requested.current.has(id)) continue;
        requested.current.add(id);
        request('provider.models', { providerId: id });
      }
    }, [active, saved, byProvider]);
    return useMemo(() => {
      const out: ModelCandidate[] = [];
      for (const profile of saved)
        for (const model of byProvider[profile.id] ?? []) {
          // A model that cannot emit text cannot drive an agent.
          if (model.outputModalities?.length && !model.outputModalities.includes('text')) continue;
          out.push({
            provider: profile.id,
            providerType: profile.type,
            model: model.id,
            label: model.name ?? model.id,
            description: model.description,
            contextWindow: model.contextWindow,
            outputModalities: model.outputModalities,
          });
        }
      return out;
    }, [saved, byProvider]);
  };

  return {
    send: request,
    on,
    useSessionId: () => null,
    useFleetAgents: () => NO_AGENTS,
    useModelCandidates,
    useDefaultModel: () => NO_DEFAULT,
    openRun,
    BoardExtras,
    TaskExtras,
  };
}
