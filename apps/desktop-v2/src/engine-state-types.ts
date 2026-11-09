import type { UserInputRequest } from '@wrongstack/contracts/types';
import type { WorktreeTimelineEvent } from '@wrongstack/contracts/types/worktree-timeline';
import type { CouncilLog } from '@wrongstack/project-surfaces/council/panels';
import type { CouncilDecisionData } from '@wrongstack/project-surfaces/council/types';
import type { FleetFold } from '@wrongstack/project-surfaces/office/fleet-fold';
import type { ParsedNextStep } from '@wrongstack/webui-protocol';
import type { AgentTranscripts } from './agent-transcripts';
import type { BrainMessage } from './brain-message';
import type { ComposerAttachment } from './composer-attachments';
import type { ContextUsage, TokenTotals, TurnStats } from './context-usage';
import type { ConversationNotice } from './conversation-notices';
import type { DelegationRecord } from './delegations';
import type { FleetGauge } from './fleet-gauge';
import type { MemoryContext, MemoryInjectorRun } from './memory-injections';
import type { MemoryReviews } from './memory-reviews';
import type { WaitingRoom } from './provider-waiting';
import type { ServiceHealing } from './service-healing';

export interface EngineEvent {
  type: string;
  payload: Record<string, unknown>;
  /** When the desktop received the frame (epoch ms); token deltas and older journals have none. */
  at?: number;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** When it was written, from the frame that added it (epoch ms); unknown in older journals. */
  at?: number;
  attachments?: ComposerAttachment[];
  streamId?: string;
  /** Original user text before refinement, retained for action receipts. */
  journalRaw?: string;
  /** Work that happened after this message, before the next message began. */
  activityAfter?: EngineEvent[];
  /** A Brain council's decision, drawn as the WebUI's council card. */
  council?: CouncilDecisionData;
  brain?: BrainMessage;
  /** An actionable review delivered to this conversation, retained by journal replay. */
  chimera?: { reportId: string; sessionId: string };
}
export interface ProviderTestRun {
  id: string;
  provider: string;
  total: number;
  results: Record<string, Record<string, unknown>>;
  complete: Record<string, unknown> | null;
}
export interface EngineState {
  hydrating: boolean;
  /** False until a reader first reaches the end of the journal; views wait for it. */
  synced: boolean;
  pendingUserMessages: Record<string, ChatMessage>;
  queue: Array<{ id: string; text: string; addedAt: number; imageCount: number }>;
  drainedPromptIds: string[];
  assists: Record<
    string,
    {
      text: string;
      status: string;
      error?: string;
      appliedEdits?: boolean;
      /** Files the engine captured before an editing run wrote them (null = created). */
      edits?: { path: string; before: string | null }[];
      /** Tools or files whose changes the engine could not capture. */
      uncaptured?: string[];
    }
  >;
  sessionId: string;
  provider: string;
  model: string;
  connected: boolean;
  running: boolean;
  needsSetup: boolean;
  messages: ChatMessage[];
  /** Work before the first visible message (e.g. a resumed engine-only run). */
  leadingActivity: EngineEvent[];
  /** Only this message may still receive text deltas from the current response. */
  activeTextMessageId: string | null;
  approvals: Record<string, unknown>[];
  inputs: UserInputRequest[];
  providerTests: Record<string, ProviderTestRun>;
  goalStates: Record<string, Record<string, unknown>>;
  goalErrors: Record<string, Record<string, unknown>>;
  sddInterviewId: string;
  sddAgentText: string;
  specDetails: Record<string, Record<string, unknown>>;
  activity: EngineEvent[];
  /** How full the conversation's context window is. */
  context: ContextUsage;
  /** The running turn's tool calls, thinking and retries, every one of them, oldest first. */
  runTimeline: EngineEvent[];
  /** Each finished turn's tool events, by the id of the assistant message that ended it. */
  turnActivity: Record<string, EngineEvent[]>;
  /** Each finished turn's iterations and token use, by the id of its answer. */
  turnStats: Record<string, TurnStats>;
  /** Session token totals when the running turn started. */
  runStartTotals: TokenTotals | null;
  /** When the running turn's first iteration started (frame time), for its duration. */
  runStartAt: number | null;
  /** This conversation's SAGE injector runs, newest last, and the latest request's memories. */
  memoryRuns: MemoryInjectorRun[];
  memoryContext: MemoryContext | null;
  /** The latest validity check and companion review of each memory, from every conversation. */
  memoryReviews: MemoryReviews;
  /** Engine reports about this conversation that need the user's attention, newest last. */
  notices: ConversationNotice[];
  serviceHealing: Record<string, ServiceHealing>;
  /** Notices seen, so each gets a distinct id after older ones fall out of the list. */
  noticeCount: number;
  /** Worker delegations this conversation finished, as the engine reported them. */
  delegations: DelegationRecord[];
  /** This conversation's Brain council panels, folded from `brain.event` frames. */
  council: CouncilLog;
  /** This conversation's subagent fleet, folded from `subagent.event` frames as the WebUI does. */
  fleet: FleetFold;
  /** The engine's fleet gauge (`fleet.concurrency_update`); absent until the engine sends one. */
  fleetGauge?: FleetGauge | undefined;
  nextSteps: ParsedNextStep[];
  /** The engine's worktree lifecycle log, oldest first, for the worktree timeline. */
  worktreeEvents: WorktreeTimelineEvent[];
  results: Record<string, Record<string, unknown>>;
  error: string;
  /** The latest frame time seen, for messages a token delta starts. */
  lastAt: number;
  /** Each subagent's own transcript in this conversation. */
  agents: AgentTranscripts;
  /** Provider/model pairs the engine's health tracker holds back until their limit resets. */
  waiting: WaitingRoom;
  /** How much of the journal a first read has replayed, while it is still replaying. */
  replay: { read: number; total: number } | null;
}
