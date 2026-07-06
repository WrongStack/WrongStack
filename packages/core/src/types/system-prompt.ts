import type { TextBlock } from './blocks.js';
import type { Tool } from './tool.js';
import type { MailboxAgentStatus } from '../coordination/mailbox-types.js';

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
   * Includes agents from all sessions (TUI, WebUI, CLI) in the same project.
   */
  onlineAgents?: MailboxAgentStatus[] | undefined;
}

export interface SystemPromptBuilder {
  build(ctx: BuildContext): Promise<TextBlock[]>;
}
