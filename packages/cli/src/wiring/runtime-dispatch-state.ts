/** Final runtime preparation before a CLI surface is dispatched. */

import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, ConfigStore, MemoryPort, SkillLoader } from '@wrongstack/contracts/types';
import type { Agent, Context } from '@wrongstack/core/agent';
import type { ToolRegistry } from '@wrongstack/core/registry';
import {
  createLocalSkillSuggestionSetup,
  createSkillMentionMiddleware,
  createSkillSuggestionSetup,
} from '@wrongstack/core/skills';
import { getToolDescriptionMode } from '@wrongstack/core/utils';
import type { PluginPickerItem, ToolPickerItem } from '../execute-deps.js';
import { PLUGIN_AUDIT_ENTRIES, runPluginManagementCommand } from '../plugin-management.js';
import { patchConfig } from '../utils.js';
import { setupCodebaseIndexing } from './codebase-index.js';
import { setupSage } from './sage.js';

interface RuntimeDispatchStateInput {
  getConfig: () => Config;
  setConfig: (config: Config) => void;
  configStore: ConfigStore;
  profileConfigPath: string;
  pipelines: Parameters<typeof setupSage>[0]['pipelines'];
  memoryStore: MemoryPort;
  /** Roster the skill suggester ranks. Undefined when skills are disabled. */
  skillLoader: SkillLoader | undefined;
  logger: Parameters<typeof setupSage>[0]['logger'];
  events: EventBus;
  agent: Agent;
  context: Context;
  projectRoot: string;
  toolRegistry: ToolRegistry;
  flags: Record<string, string | boolean>;
  onEvent: (event: string, handler: (payload: unknown) => void) => void;
}

export async function prepareRuntimeDispatch(input: RuntimeDispatchStateInput) {
  const runSageSessionHygiene = setupSage({
    config: input.getConfig(),
    pipelines: input.pipelines,
    memoryStore: input.memoryStore,
    logger: input.logger,
    events: input.events,
    getSessionId: () => input.agent.ctx.session.id,
    projectRoot: input.projectRoot,
  });
  // Opt-in, and a no-op unless `skills.suggest.enabled` is on AND a TypeSafe
  // key is present. Installed after SAGE so the suggestion block lands after
  // the memory block, keeping both at the volatile tail of the prompt.
  const skillSuggestion = createSkillSuggestionSetup({
    config: input.getConfig(),
    skillLoader: input.skillLoader,
    logger: input.logger,
    getSessionId: () => input.agent.ctx.session.id,
    getAvailableToolNames: () => {
      const ctx = input.agent.ctx;
      return (ctx.catalogTools.length > 0 ? ctx.catalogTools : ctx.tools).map((tool) => tool.name);
    },
  });
  if (skillSuggestion) input.pipelines.request.use(skillSuggestion);
  const localSkillSuggestion = createLocalSkillSuggestionSetup({
    config: input.getConfig(),
    skillLoader: input.skillLoader,
    logger: input.logger,
    getAvailableToolNames: () => {
      const ctx = input.agent.ctx;
      return (ctx.catalogTools.length > 0 ? ctx.catalogTools : ctx.tools).map((tool) => tool.name);
    },
  });
  if (localSkillSuggestion) input.pipelines.request.use(localSkillSuggestion);
  if (input.skillLoader && input.getConfig().features?.skills !== false)
    input.pipelines.request.use(createSkillMentionMiddleware(input.skillLoader));

  const disposeIndexing = await setupCodebaseIndexing({
    config: input.getConfig(),
    context: input.context,
    pipelines: input.pipelines,
    projectRoot: input.projectRoot,
    logger: input.logger,
  });
  process.once('exit', disposeIndexing);

  const getPluginItems = (): PluginPickerItem[] =>
    PLUGIN_AUDIT_ENTRIES.map((entry) => {
      const configured = (input.getConfig().plugins ?? []).find((plugin) =>
        typeof plugin === 'string' ? plugin === entry.name : plugin.name === entry.name,
      );
      return {
        name: entry.name,
        enabled: configured
          ? !(typeof configured === 'object' && configured.enabled === false)
          : entry.defaultState === 'active',
        risk: entry.risk,
        summary: entry.summary,
        lockable: entry.canDisable,
      };
    });

  const togglePlugin = async (name: string) => {
    const result = await runPluginManagementCommand(['toggle', name], {
      config: input.getConfig(),
      configPath: input.profileConfigPath,
    });
    if (result.patch) {
      const configPatch = result.patch as never as Partial<Config>;
      input.setConfig(patchConfig(input.getConfig(), configPatch));
      input.configStore.update(configPatch);
    }
    const restartHint =
      result.restartRequired && result.code === 0
        ? ' Restart WrongStack to load or unload plugin code in this session.'
        : '';
    return {
      items: getPluginItems(),
      message: result.code === 0 ? `${result.message}${restartHint}` : undefined,
      error: result.code === 0 ? undefined : result.message,
    };
  };

  const getToolItems = (): ToolPickerItem[] =>
    [...input.toolRegistry.listWithOwner(), ...input.toolRegistry.listDisabled()].map(
      ({ tool, owner }) => ({
        name: tool.name,
        owner,
        category: tool.category ?? 'Other',
        enabled: !input.toolRegistry.isDisabled(tool.name),
        exposure: input.toolRegistry.isDisabled(tool.name)
          ? 'disabled'
          : input.toolRegistry.isExposedToProvider(tool.name)
            ? 'direct'
            : 'lazy',
        mutating: tool.mutating,
        permission: tool.permission,
        descMode: getToolDescriptionMode(input.toolRegistry, tool.name),
        description: tool.description,
      }),
    );

  input.onEvent('chimera.set_autofix', (payload) => {
    const mode = (payload as { mode?: string })?.mode;
    if (mode && ['off', 'ask', 'auto'].includes(mode))
      input.agent.ctx.meta['chimeraAutoFix'] = mode;
  });
  const autoFix = input.flags['chimera-auto-fix'];
  if (typeof autoFix === 'string') {
    const mode = autoFix.toLowerCase();
    if (mode === 'off' || mode === 'ask' || mode === 'auto') {
      input.agent.ctx.meta['chimeraAutoFix'] = mode;
    }
  }

  return { runSageSessionHygiene, getPluginItems, togglePlugin, getToolItems };
}
