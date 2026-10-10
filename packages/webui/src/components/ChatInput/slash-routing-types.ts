import type { WSClientMessage } from '@/types';

/** Contracts for `runChatSlashCommand` and its per-command helpers. */

export interface ChatAssistantMessage {
  role: 'assistant';
  content: string;
}

export type SlashRoutingView = 'chat' | 'sessions' | 'settings';

export type SlashRoutingClientMessage = Extract<
  WSClientMessage,
  | { type: 'webui.shutdown' }
  | { type: 'brain.risk' }
  | { type: 'brain.ask' }
  | { type: 'brain.status' }
  | { type: 'autonomy.switch' }
  | { type: 'goal.get' }
  | { type: 'goal-state.get' }
  | { type: 'goal-state.set' }
  | { type: 'goal-state.refine' }
  | { type: 'goal-state.pause' }
  | { type: 'goal-state.resume' }
  | { type: 'goal-state.clear' }
  | { type: 'mode.switch' }
  | { type: 'modes.list' }
  | { type: 'mcp.list' }
  | { type: 'mcp.resources' }
  | { type: 'mcp.prompts' }
  | { type: 'mcp.resource.read' }
  | { type: 'mcp.prompt.get' }
  | { type: 'working_dir.set' }
  | { type: 'goal.start' }
  | { type: 'goal.load' }
  | { type: 'goal.save' }
  | { type: 'goal.list' }
  | { type: 'goal.pause' }
  | { type: 'goal.resume' }
  | { type: 'goal.stop' }
  | { type: 'goal.status' }
  | { type: 'config.doctor' }
  | { type: 'prefs.update' }
>;

export interface SlashRoutingClient {
  send?: (message: SlashRoutingClientMessage) => void;
  /**
   * Stamp a payload with the foreground session's id, when one is bound.
   * Session-sensitive commands (/autonomy, /mode) MUST route through this —
   * a raw `send` left them unstamped, so the runtime applied them to
   * whichever tab it currently considered active instead of the tab the
   * command was typed in.
   */
  withSession?: <T extends Record<string, unknown>>(payload: T) => T;
  clearContext?: () => void;
  newSession?: (payload?: { replaceSessionId?: string; systemPromptVariant?: string }) => void;
  compactContext?: (aggressive?: boolean) => void;
  repairContext?: () => void;
  clearTodos?: () => void;
}

/** Stripped-down queue item for slash-command routing — only the text
 *  is meaningful for `/queue` listing. */
export type SlashQueueItem = { text: string };

export interface SlashRoutingWs {
  listTools: () => void;
  listMemory: () => void;
  listSkills: () => void;
  getDiag: () => void;
  getStats: () => void;
  saveSession: () => void;
  listSessions: (limit?: number) => void;
  getPlan: () => void;
}

export interface RunChatSlashCommandOptions {
  raw: string;
  addMessage: (message: ChatAssistantMessage) => void;
  clearMessages: () => void;
  /**
   * Does the lane believe a run is in flight? `/clear` needs the answer:
   * wiping the transcript without settling the run flag leaves the pane in
   * its loading branch over zero rows — a blank box where the welcome screen
   * belongs. See the `/clear` case.
   */
  isLoading: boolean;
  client: SlashRoutingClient | null | undefined;
  queue: readonly SlashQueueItem[];
  sendAbort: () => void;
  sendMsg: (content: string) => void;
  setLoading: (loading: boolean) => void;
  setCurrentView: (view: SlashRoutingView) => void;
  toggleRefineEnabled: () => void;
  setProcessMonitorOpen: (open: boolean) => void;
  setQueuePanelOpen: (open: boolean) => void;
  ws: SlashRoutingWs;
  onOpenBreakdown?: (() => void) | undefined;
  handleNextList: () => boolean;
  handleNextSelect: (args: string) => boolean;
  sessionId?: string | null | undefined;
}
