import type { ConfigStore } from '@wrongstack/contracts/types';
import type { Settings } from './app-reducer.js';
import type { AuthPanelHost } from './auth-panel-model.js';
import type { BrainRiskLevel } from './brain-contracts.js';
import type { McpPickerItem, PluginPickerItem, ToolPickerItem } from './ui-contracts.js';
export interface TuiSettingsProps {
  /**
   * Read the persisted autonomy settings (defaultMode, autoProceedDelayMs).
   * Used by the SettingsPicker in the TUI on mount and after Ctrl+S toggle.
   */
  /** Settings shape — shared between getSettings and saveSettings. */
  getSettings?: (() => Settings) | undefined;
  /**
   * The leader's own effort override (`leader_effort_set`), while it is in
   * force. Display-only: kept apart from `getSettings` so the settings picker
   * never reads — and on save persists — the leader's choice as the user's.
   */
  getLeaderEffort?: (() => string | undefined) | undefined;
  /**
   * Live view over the persisted user config. The TUI uses this to:
   * - apply `themePreset` on boot (so `/theme` choices persist across
   *   restarts), and
   * - write `themePreset` back when the picker Enter handler fires
   *   (so the picker shows `[active]` on the right row next session).
   *
   * Optional for hosts that don't expose a config store (e.g. tests);
   * when omitted the TUI stays on the default catppuccin palette and
   * picker changes are ephemeral.
   */
  configStore?: ConfigStore | undefined;
  /**
   * Persist settings changes. Returns null on success, or an
   * error string on failure (so the TUI can display it as a hint).
   */
  saveSettings?: ((s: Settings) => string | null | Promise<string | null>) | undefined;
  /** Persist the active theme preset to disk so the next boot starts with it. */
  saveThemePreset?:
    | ((preset: import('@wrongstack/contracts/types').ThemePresetId) => Promise<void>)
    | undefined;
  /** Load toggleable plugin rows for the interactive plugin picker. */
  getPluginItems?: (() => PluginPickerItem[]) | undefined;
  /** Toggle one plugin from the interactive picker and return the refreshed rows. */
  onPluginToggle?:
    | ((name: string) => Promise<{
        items: PluginPickerItem[];
        message?: string | undefined;
        error?: string | undefined;
      }>)
    | undefined;
  /** Load MCP server rows for the interactive MCP picker. */
  getMcpServers?: (() => McpPickerItem[]) | undefined;
  onMcpManage?:
    | ((
        action: 'add' | 'edit' | 'remove',
        input: Pick<McpPickerItem, 'name' | 'transport' | 'command' | 'url' | 'args'>,
      ) => Promise<{
        items: McpPickerItem[];
        message?: string | undefined;
        error?: string | undefined;
      }>)
    | undefined;
  /** Toggle one MCP server (enable/disable) from the interactive picker. */
  onMcpToggle?:
    | ((name: string) => Promise<{
        items: McpPickerItem[];
        message?: string | undefined;
        error?: string | undefined;
      }>)
    | undefined;
  /** Restart one MCP server from the interactive picker. */
  onMcpRestart?:
    | ((name: string) => Promise<{
        items: McpPickerItem[];
        message?: string | undefined;
        error?: string | undefined;
      }>)
    | undefined;
  /** Load tool rows for the interactive tool picker. */
  getToolsItems?: (() => ToolPickerItem[]) | undefined;
  /** Toggle one tool (enable/disable) from the interactive tool picker. */
  onToolToggle?:
    | ((name: string) => Promise<{
        items: ToolPickerItem[];
        message?: string | undefined;
        error?: string | undefined;
      }>)
    | undefined;
  /** Get current brain risk level and decision log. */
  getBrainData?:
    | (() => {
        riskLevel: BrainRiskLevel;
        log: Array<{ kind: string; question: string; outcome: string; age: string }>;
      })
    | undefined;
  /** Set brain risk ceiling. */
  onBrainRiskLevel?: ((level: BrainRiskLevel) => string | undefined) | undefined;
  /** Full Brain settings editor bridge (live apply + persist). */
  brainPanelHost?: import('./brain-panel-model.js').BrainPanelHost | undefined;
  /**
   * Session-scoped subagent model plan bridge for `/subagent-models`. The host
   * owns the plan (it needs the session writer to journal it); the panel only
   * reads snapshots and calls back. Absent = the panel stays unavailable and
   * the slash command falls back to its text output.
   */
  subagentModelsHost?:
    | import('./subagent-models-panel-model.js').SubagentModelsPanelHost
    | undefined;
  /** Get current Shadow Agent state. */
  getShadowData?:
    | (() => { activeId: string | null; running: boolean; model: string; intervalMs: number })
    | undefined;
  /** Start Shadow Agent. Returns message or error. */
  onShadowStart?: (() => Promise<string | undefined>) | undefined;
  /** Stop Shadow Agent. Returns message or error. */
  onShadowStop?: (() => Promise<string | undefined>) | undefined;
  /**
   * Host for the interactive `/auth` panel (provider/key management, OAuth
   * sign-in, local-server add). Provided by the CLI; when absent, `/auth`
   * falls back to its plain-text output.
   */
  authHost?: AuthPanelHost | undefined;
}
