import type { PluginAPI, ProviderFactory, SlashCommand, Tool } from '@wrongstack/contracts/types';
import type { AgentExtension } from '@wrongstack/core/extension';

/**
 * A first-party or third-party capability bundle that can be mounted by a
 * host runtime. Tools, providers, MCP integrations, UI surfaces, and director
 * features should converge on this shape instead of being hard-wired into CLI
 * boot code.
 */
export interface WrongStackPack {
  /** Stable package/pack id, e.g. "builtin-tools" or "mcp". */
  name: string;
  /** Human-readable one-line description for diagnostics and package lists. */
  description?: string | undefined;
  /** Tools to register into the host ToolRegistry. */
  tools?: readonly Tool[] | undefined;
  /** Provider factories to register into the host ProviderRegistry. */
  providers?: readonly ProviderFactory[] | undefined;
  /** Slash commands to register into REPL/TUI surfaces. */
  slashCommands?: readonly SlashCommand[] | undefined;
  /** Agent lifecycle extensions to register. */
  extensions?: readonly AgentExtension[] | undefined;
  /** Optional imperative setup for packs that need host APIs. */
  setup?(api: PluginAPI): void | Promise<void>;
  /**
   * Optional best-effort teardown for resources started by setup(). Called
   * after a partially completed setup throws as well as during normal unload.
   */
  teardown?(api: PluginAPI): void | Promise<void>;
}
