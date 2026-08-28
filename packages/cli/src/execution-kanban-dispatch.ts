import { randomUUID } from 'node:crypto';
import { missingRequiredRuntimeTools } from '@wrongstack/core/agent-catalog';
import { WIDE_SUBAGENT_CAPABILITIES } from '@wrongstack/core/security';
import { stripFrontmatter } from '@wrongstack/core/skills';
import type { WebUIDispatchContext } from './boot/dispatch-webui.js';
import type { ExecuteDeps } from './execute-deps.js';
import { resolveKanbanDispatchRoute } from './kanban-dispatch-route.js';

type KanbanDispatchHandler = NonNullable<WebUIDispatchContext['onKanbanDispatch']>;

type CreateKanbanDispatchHandlerOptions = {
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
      // Every other skill-injection site gates on capabilities/tools and strips
      // the YAML frontmatter (see `buildFleetAgentContext` in fleet/host-context.ts).
      // This one did neither: it force-fed the raw file — frontmatter included —
      // into the worker prompt, and threw the whole dispatch away when a single
      // skill was missing. A skill is prompt seasoning; it must not decide
      // whether the task runs.
      const availableToolNames = spawnOpts.tools;
      const loaded: string[] = [];
      for (const skillName of spawnOpts.skills) {
        try {
          const manifest = await skillLoader.find(skillName);
          if (!manifest) {
            process.emitWarning(`Kanban dispatch skill not found, skipped: ${skillName}`, {
              code: 'WRONGSTACK_KANBAN_SKILL_SKIPPED',
            });
            continue;
          }
          // Tool names are only known when the caller pinned them; an unpinned
          // worker gets the default set, which cannot be checked from here.
          if (
            availableToolNames !== undefined &&
            missingRequiredRuntimeTools(manifest.requiredTools, availableToolNames).length > 0
          ) {
            process.emitWarning(
              `Kanban dispatch skill "${skillName}" needs tools this worker does not have, skipped.`,
              { code: 'WRONGSTACK_KANBAN_SKILL_SKIPPED' },
            );
            continue;
          }
          const body = stripFrontmatter(await skillLoader.readBody(skillName)).trim();
          if (!body) continue;
          loaded.push(`## Required skill: ${skillName}\n\n${body}`);
        } catch (err) {
          process.emitWarning(
            `Kanban dispatch skill "${skillName}" could not be loaded, skipped: ${
              err instanceof Error ? err.message : String(err)
            }`,
            { code: 'WRONGSTACK_KANBAN_SKILL_SKIPPED' },
          );
        }
      }
      if (loaded.length > 0) {
        agentDescription = `${description}\n\n# Required agentic skill instructions\n\n${loaded.join('\n\n')}`;
      }
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
