import type { MailboxAgentStatus } from '../coordination/mailbox-types.js';
import type { TextBlock } from './blocks.js';
import type { Tool } from './tool.js';

/** Model capabilities relevant to prompt composition. */
export interface ModelCapabilities {
  maxContextTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
}

export interface BuildContext {
  cwd: string;
  projectRoot: string;
  tools: Tool[];
  /** Complete enabled catalog, including tools reachable only through lazy gateways. */
  catalogTools?: Tool[] | undefined;
  /** Provider id (e.g. "anthropic", "minimax-coding-plan"). */
  provider?: string | undefined;
  /** Model id (e.g. "configured-model", "MiniMax-M2.7"). */
  model?: string | undefined;
  /**
   * True when the prompt is being built for a SUBAGENT, not the host
   * agent. Subagents are scoped to a single task — they should NOT see
   * the host's strategic plan board (which is anchoring the host across
   * turns, not steering individual subtasks). The plan-injection
   * layer short-circuits when this flag is set.
   */
  subagent?: boolean | undefined;
  /**
   * List of currently online agents in the shared mailbox system.
   * Includes agents from all clients, processes, sessions, branches, and
   * linked Git worktrees in the same canonical project.
   */
  onlineAgents?: MailboxAgentStatus[] | undefined;
}

/**
 * Stability regions for the system prompt.
 *
 * `core` and `session` form the provider-cache prefix and must remain byte-for-byte
 * stable after the first request in a session. `volatile` is appended at request
 * time and may change between turns without rewriting that prefix.
 */
export interface SystemPromptRegions {
  readonly core: readonly TextBlock[];
  readonly session: readonly TextBlock[];
  readonly volatile: readonly TextBlock[];
}

export function flattenSystemPromptRegions(regions: SystemPromptRegions): TextBlock[] {
  return [...regions.core, ...regions.session, ...regions.volatile];
}

export interface SystemPromptBuilder {
  build(ctx: BuildContext): Promise<TextBlock[]>;
  /** Region-aware build used by hosts that enforce prompt-prefix stability. */
  buildRegions?(ctx: BuildContext): Promise<SystemPromptRegions>;
}
