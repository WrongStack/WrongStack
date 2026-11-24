/**
 * Declarative per-client capability & compatibility profiles for ACP agents.
 *
 * External ACP agents differ in how they accept MCP server configs, whether
 * they honor Claude's `_meta.systemPrompt.append` extension, how they format
 * MCP tool names in permission prompts, and whether they require an explicit
 * initial permission mode. Centralizing these rules prevents scattered
 * `if (id === 'claude-code')` / `if (id === 'copilot')` checks across packages.
 */

import { AGENTS_CATALOG } from './agents.catalog.js';

export type AcpMcpInjectionMode = 'acp-session-new' | 'copilot-temp-json' | 'pi-env-json';

export type AcpSystemPromptChannel = 'meta-system-prompt-append' | 'first-turn-context-block';

export type AcpMcpToolNamingStyle = 'claude-double-underscore' | 'adapted-on-server';

export interface AcpClientProfile {
  /** Canonical profile identifier (matches catalog or registry id). */
  readonly id: string;
  /** How WrongStack hands MCP server definitions to this ACP client. */
  readonly mcpInjection: AcpMcpInjectionMode;
  /**
   * How WrongStack delivers its project service guide (`bridgeNote` / `leaderBridgeNote`).
   * - `meta-system-prompt-append`: Claude ACP adapter reads `_meta.systemPrompt.append`
   *   and keeps the system prompt cache-warm across tasks.
   * - `first-turn-context-block`: Standard ACP v1 clients ignore `_meta.systemPrompt`,
   *   so the guide is prepended once in the first user turn's `<wrongstack-project-context>` block.
   */
  readonly systemPromptChannel: AcpSystemPromptChannel;
  /** How MCP tool references should be written in prompts/reminders for this client. */
  readonly mcpToolNaming: AcpMcpToolNamingStyle;
  /** Initial ACP mode forced when WrongStack's permission bridge is active. */
  readonly initialMode?: { readonly id: string; readonly require: boolean } | undefined;
  /**
   * Whether WrongStack's internal MCP bridge (sage, codebase-index, kanban, mailbox)
   * should attach by default when the user has not explicitly restricted `acp.bridge.agents`.
   */
  readonly bridgeByDefault: boolean;
  /**
   * When true and the user has not explicitly configured `acp.bridge.indexSurface`,
   * expose WrongStack's Codebase Index through `wstack tools run codebase-*` CLI
   * instead of an MCP server (for ACP clients that ignore `session/new` `mcpServers`,
   * such as current `kimi acp`).
   */
  readonly preferCliIndexSurface?: boolean | undefined;
  /**
   * When false, this ACP client ignores `mcpServers` passed in `session/new`
   * (e.g. current `kimi acp`). WrongStack omits unattachable MCP servers from
   * its prompt notes so the model is not told to call unavailable MCP tools,
   * and routes Codebase Index through the `wstack tools` CLI surface instead.
   */
  readonly supportsSessionMcp?: boolean | undefined;
}

export const DEFAULT_GENERIC_ACP_PROFILE: AcpClientProfile = {
  id: 'generic',
  mcpInjection: 'acp-session-new',
  systemPromptChannel: 'first-turn-context-block',
  mcpToolNaming: 'adapted-on-server',
  bridgeByDefault: true,
};

const CLAUDE_PROFILE: AcpClientProfile = {
  id: 'claude-code',
  mcpInjection: 'acp-session-new',
  systemPromptChannel: 'meta-system-prompt-append',
  mcpToolNaming: 'claude-double-underscore',
  initialMode: { id: 'default', require: true },
  bridgeByDefault: true,
};

const COPILOT_PROFILE: AcpClientProfile = {
  id: 'copilot',
  mcpInjection: 'copilot-temp-json',
  systemPromptChannel: 'first-turn-context-block',
  mcpToolNaming: 'adapted-on-server',
  bridgeByDefault: true,
};

const PI_ACP_PROFILE: AcpClientProfile = {
  id: 'pi-acp',
  mcpInjection: 'pi-env-json',
  systemPromptChannel: 'first-turn-context-block',
  mcpToolNaming: 'adapted-on-server',
  bridgeByDefault: true,
};

const ACP_CLIENT_PROFILES: Readonly<Record<string, AcpClientProfile>> = {
  'claude-code': CLAUDE_PROFILE,
  'claude-acp': CLAUDE_PROFILE,
  copilot: COPILOT_PROFILE,
  'github-copilot-cli': COPILOT_PROFILE,
  'pi-acp': PI_ACP_PROFILE,
  // First-class native & adapter ACP clients (standard session/new mcpServers)
  'codex-cli': { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'codex-cli' },
  'codex-acp': { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'codex-acp' },
  'gemini-cli': { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'gemini-cli' },
  gemini: { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'gemini' },
  opencode: { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'opencode' },
  'kimi-code': {
    ...DEFAULT_GENERIC_ACP_PROFILE,
    id: 'kimi-code',
    preferCliIndexSurface: true,
    supportsSessionMcp: false,
  },
  kimi: {
    ...DEFAULT_GENERIC_ACP_PROFILE,
    id: 'kimi',
    preferCliIndexSurface: true,
    supportsSessionMcp: false,
  },
  cursor: { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'cursor' },
  cline: { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'cline' },
  goose: { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'goose' },
  kiro: { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'kiro' },
  'kiro-cli': { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'kiro-cli' },
  'qwen-code': { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'qwen-code' },
  'mistral-vibe': { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'mistral-vibe' },
  'antigravity-acp': { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'antigravity-acp' },
  'amp-acp': { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'amp-acp' },
  auggie: { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'auggie' },
  devin: { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'devin' },
  'factory-droid': { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'factory-droid' },
  'grok-build': { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'grok-build' },
  junie: { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'junie' },
  kilo: { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'kilo' },
  // OpenHands has no official ACP registry entry yet; keep opt-in for bridge.
  openhands: { ...DEFAULT_GENERIC_ACP_PROFILE, id: 'openhands', bridgeByDefault: false },
};

/** Resolve the capability/compatibility profile for any catalog or live-registry ACP agent id. */
export function resolveAcpClientProfile(agentId: string | undefined): AcpClientProfile {
  if (!agentId) return DEFAULT_GENERIC_ACP_PROFILE;
  const normalized = agentId.trim().toLowerCase();
  return Object.hasOwn(ACP_CLIENT_PROFILES, normalized)
    ? ACP_CLIENT_PROFILES[normalized]!
    : { ...DEFAULT_GENERIC_ACP_PROFILE, id: normalized };
}

/**
 * Derive default MCP-bridged ACP agent ids dynamically from the bundled catalog
 * plus any live-synced official ACP Registry ids (`agentclientprotocol/registry`),
 * filtered by `resolveAcpClientProfile(id).bridgeByDefault`.
 */
export function defaultBridgeAgentIds(liveIds?: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    const normalized = id.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return;
    if (!resolveAcpClientProfile(normalized).bridgeByDefault) return;
    seen.add(normalized);
    out.push(normalized);
  };
  for (const entry of AGENTS_CATALOG) add(entry.id);
  if (liveIds) {
    for (const id of liveIds) add(id);
  }
  return out;
}

/** Default MCP-bridged agent ids derived directly from `AGENTS_CATALOG` (never hardcoded). */
export const DEFAULT_BRIDGE_AGENTS: readonly string[] = defaultBridgeAgentIds();
