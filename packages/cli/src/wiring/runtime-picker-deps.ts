/**
 * Builds the picker-facing runtime boundary used by CLI surfaces.
 *
 * Picker state is intentionally assembled outside `cli-main.ts`: the entry
 * point owns phase ordering, while this module owns MCP/tool/Brain projection
 * and mutations.
 */
import { allServers } from '@wrongstack/core/infrastructure';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { Config, ConfigStore } from '@wrongstack/core/types';
import type { MCPRegistry } from '@wrongstack/mcp';
import type { PickerDeps, PluginPickerItem, ToolPickerItem } from '../execute-deps.js';
import { patchConfig } from '../utils.js';

interface RuntimePickerDepsInput {
  getConfig: () => Config;
  setConfig: (config: Config) => void;
  profileConfigPath: string;
  mcpRegistry: MCPRegistry;
  toolRegistry: ToolRegistry;
  configStore: Pick<ConfigStore, 'update'>;
  getPluginItems: () => PluginPickerItem[];
  togglePlugin: NonNullable<PickerDeps['onPluginToggle']>;
  getToolItems: () => ToolPickerItem[];
  brain: PickerDeps['brain'];
  brainSettings: PickerDeps['brainSettings'];
  brainRuntime: PickerDeps['brainRuntime'];
  getBrainLog: NonNullable<PickerDeps['getBrainLog']>;
}

export function createRuntimePickerDeps(input: RuntimePickerDepsInput): PickerDeps {
  const listMcpItems = async () => {
    const { listMcp } = await import('@wrongstack/mcp');
    const items = await listMcp({
      configPath: input.profileConfigPath,
      registry: input.mcpRegistry,
      presets: allServers(),
    });
    return items.map((server) => ({
      name: server.name,
      enabled: server.enabled,
      status: server.status,
      transport: server.transport,
      description: server.description,
      toolCount: server.tools.length,
      lazy: server.lazy,
    }));
  };

  return {
    getPluginItems: input.getPluginItems,
    onPluginToggle: input.togglePlugin,
    getMcpServers: () => {
      const servers = (input.getConfig().mcpServers ?? {}) as Record<
        string,
        {
          name: string;
          transport: string;
          enabled?: boolean;
          description?: string;
          lazy?: boolean;
        }
      >;
      const liveMap = new Map(input.mcpRegistry.list().map((server) => [server.name, server]));
      return Object.entries(servers).map(([name, config]) => {
        const live = liveMap.get(name);
        return {
          name,
          enabled: config.enabled !== false,
          status: live ? live.state : 'stopped',
          transport: config.transport ?? 'stdio',
          description: config.description,
          toolCount: live?.toolCount ?? 0,
          lazy: config.lazy,
        };
      });
    },
    onMcpToggle: async (name) => {
      const { enableMcp, disableMcp } = await import('@wrongstack/mcp');
      const deps = {
        configPath: input.profileConfigPath,
        registry: input.mcpRegistry,
        presets: allServers(),
      };
      const live = input.mcpRegistry.list().find((server) => server.name === name);
      const isCurrentlyEnabled = live !== undefined && live.state !== 'idle';
      const result = isCurrentlyEnabled
        ? await disableMcp(name, deps)
        : await enableMcp(name, deps);
      return {
        items: await listMcpItems(),
        message: result.ok
          ? result.server
            ? `${result.server.status === 'connected' ? '●' : '○'} ${name}`
            : result.message
          : undefined,
        error: result.ok ? undefined : result.message,
      };
    },
    onMcpRestart: async (name) => {
      try {
        await input.mcpRegistry.restart(name);
      } catch (error) {
        return {
          items: await listMcpItems(),
          message: undefined,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      return {
        items: await listMcpItems(),
        message: `Restarted "${name}".`,
        error: undefined,
      };
    },
    getToolsItems: input.getToolItems,
    onToolToggle: async (name) => {
      const config = input.getConfig();
      const disabled = new Set(config.tools?.disabledTools ?? []);
      const isCurrentlyDisabled = input.toolRegistry.isDisabled(name);
      if (isCurrentlyDisabled) {
        input.toolRegistry.enable(name);
        disabled.delete(name);
      } else {
        input.toolRegistry.disable(name);
        disabled.add(name);
      }
      const tools = { ...(config.tools ?? {}), disabledTools: Array.from(disabled) };
      input.setConfig(patchConfig(config, { tools }));
      input.configStore.update({ tools });
      return {
        items: input.getToolItems(),
        message: isCurrentlyDisabled ? `Enabled "${name}".` : `Disabled "${name}".`,
        error: undefined,
      };
    },
    getBrainData: () => {
      const riskLevel = input.brainSettings?.maxAutoRisk ?? 'medium';
      const log = input
        .getBrainLog()
        .slice(-20)
        .map((entry) => ({
          kind: entry.kind,
          question: entry.question,
          outcome: entry.outcome,
          age: formatAge(entry.at),
        }));
      return { riskLevel, log };
    },
    onBrainRiskLevel: (level) => {
      if (!input.brainSettings) return 'Brain settings not available.';
      input.brainSettings.maxAutoRisk = level;
      return undefined;
    },
    brain: input.brain,
    brainSettings: input.brainSettings,
    brainRuntime: input.brainRuntime,
    getBrainLog: input.getBrainLog,
  };
}

function formatAge(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}
