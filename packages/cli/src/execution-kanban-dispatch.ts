import { randomUUID } from 'node:crypto';
import { WIDE_SUBAGENT_CAPABILITIES } from '@wrongstack/core/security';
import type { WebUIDispatchContext } from './boot/dispatch-webui.js';
import type { ExecuteDeps } from './execute-deps.js';
import { resolveKanbanDispatchRoute } from './kanban-dispatch-route.js';

type KanbanDispatchHandler = NonNullable<WebUIDispatchContext['onKanbanDispatch']>;

export type CreateKanbanDispatchHandlerOptions = {
  config: ExecuteDeps['core']['config'];
  events: ExecuteDeps['core']['events'];
  skillLoader: ExecuteDeps['ui']['skillLoader'];
  sddSubagentFactory: ExecuteDeps['provider']['sddSubagentFactory'];
};

export function createKanbanDispatchHandler({
  config,
  events,
  skillLoader,
  sddSubagentFactory,
}: CreateKanbanDispatchHandlerOptions): Pick<WebUIDispatchContext, 'onKanbanDispatch'> {
  if (!sddSubagentFactory) return {};

  const onKanbanDispatch: KanbanDispatchHandler = async (description, spawnOpts) => {
    const subagentId = `kanban-${randomUUID().slice(0, 8)}`;
    const taskId = randomUUID();
    const name = spawnOpts?.name ?? 'kanban-agent';
    const {
      provider: resolvedProvider,
      model: resolvedModel,
      fallbackModels: resolvedFallbackModels,
    } = resolveKanbanDispatchRoute(config, spawnOpts);
    let agentDescription = description;
    if (spawnOpts?.skills?.length && skillLoader) {
      const loaded = await Promise.all(
        spawnOpts.skills.map(async (skillName) => {
          const manifest = await skillLoader.find(skillName);
          if (!manifest) throw new Error(`Kanban skill not found: ${skillName}`);
          const body = await skillLoader.readBody(skillName);
          return `## Required skill: ${skillName}\n\n${body}`;
        }),
      );
      agentDescription = `${description}\n\n# Required agentic skill instructions\n\n${loaded.join('\n\n')}`;
    }
    void (async () => {
      const built = await sddSubagentFactory({
        id: subagentId,
        name,
        role: 'kanban-agent',
        prompt: agentDescription,
        allowedCapabilities: spawnOpts?.allowedCapabilities ?? WIDE_SUBAGENT_CAPABILITIES,
        ...(resolvedProvider ? { provider: resolvedProvider } : {}),
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(resolvedFallbackModels ? { fallbackModels: resolvedFallbackModels } : {}),
        ...(spawnOpts?.tools ? { tools: spawnOpts.tools } : {}),
      });
      try {
        const result = await built.agent.run(agentDescription);
        await spawnOpts?.onDone?.({
          status: result.status === 'done' ? 'completed' : 'failed',
          result: result.finalText,
          ...('error' in result && result.error?.message ? { error: result.error.message } : {}),
        });
      } catch (err) {
        await spawnOpts?.onDone?.({
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        await built.dispose?.();
      }
    })().catch((err) => {
      events.emit('error', {
        err: err instanceof Error ? err : new Error(String(err)),
        phase: 'kanban.dispatch',
      });
    });
    const tags: string[] = [];
    if (resolvedProvider) tags.push(resolvedProvider);
    if (resolvedModel) tags.push(resolvedModel);
    if (resolvedFallbackModels?.length) {
      tags.push(`fallback=${resolvedFallbackModels.join(',')}`);
    }
    if (spawnOpts?.fallbackProfile) tags.push(`profile=${spawnOpts.fallbackProfile}`);
    if (spawnOpts?.skills?.length) tags.push(`skills=${spawnOpts.skills.join(',')}`);
    if (spawnOpts?.name) tags.push(`"${spawnOpts.name}"`);
    const tag = tags.length > 0 ? ` (${tags.join(' / ')})` : '';
    return `Spawned subagent ${subagentId}${tag} for task ${taskId}.`;
  };

  return { onKanbanDispatch };
}
