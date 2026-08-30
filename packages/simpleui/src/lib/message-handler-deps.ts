/**
 * Dependency contract for the SimpleUI message handler factory.
 *
 * Split into its own module so `message-handler-session-start.ts` can import
 * the type without importing the handler factory — a type-level cycle that
 * the architecture gate (ARCH-CYCLE-TYPE check) would otherwise flag.
 */

import type { FallbackPendingProjection } from '../fallback-modal.js';
import type {
  AgentMode,
  AgentTranscriptEntry,
  ChatMessage,
  ContextInfo,
  FileEditMeta,
  ModelDescriptor,
  PendingConfirm,
  ResumeProgressInfo,
  SessionInfo,
  SimpleSessionSummary,
  SimpleSubagent,
  ToolCallInfo,
} from '../types.js';
import type { FileMention } from './file-mention.js';
import type { SimplePrefs } from './prefs-model.js';
import type { QueuedItem } from './queue-model.js';
import type { RefineState } from './refine-model.js';
import type { StatusNoticeProjection } from './status-notice.js';
import type { WorklistStore } from './worklist-store.js';

export interface MessageHandlerDeps {
  // Refs — used for reading current state without re-render dependencies
  prefsRef: { current: SimplePrefs };
  draftRef: { current: string };
  fileRefsRef: { current: string[] };
  queueRef: { current: QueuedItem[] };
  sessionIdRef: { current: string | null };
  messagesRef: { current: ChatMessage[] };
  activeModelRef: { current: { provider: string; model: string } | null };
  runningRef: { current: boolean };
  refineStateRef: { current: RefineState | null };
  refineEpochRef: { current: number };
  requestedModelsRef: { current: Set<string> };
  socketRef: {
    current: { send: (type: string, payload?: Record<string, unknown>) => void } | null;
  };
  stickToBottomRef: { current: boolean };

  // State setters
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setRunning: React.Dispatch<React.SetStateAction<boolean>>;
  setActivity: React.Dispatch<React.SetStateAction<string>>;
  setToolCalls: React.Dispatch<React.SetStateAction<ToolCallInfo[]>>;
  setSubagents: React.Dispatch<React.SetStateAction<SimpleSubagent[]>>;
  setAgentTranscripts: React.Dispatch<React.SetStateAction<Record<string, AgentTranscriptEntry[]>>>;
  setSession: React.Dispatch<React.SetStateAction<SessionInfo | null>>;
  setResumeProgress?: React.Dispatch<React.SetStateAction<ResumeProgressInfo | null>>;
  setSessionMenuOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  setSessions: React.Dispatch<React.SetStateAction<SimpleSessionSummary[]>>;
  setContext: React.Dispatch<React.SetStateAction<ContextInfo>>;
  setModels: React.Dispatch<React.SetStateAction<Record<string, ModelDescriptor[]>>>;
  setModes: React.Dispatch<React.SetStateAction<AgentMode[]>>;
  setActiveModeId: React.Dispatch<React.SetStateAction<string>>;
  setPrefs: React.Dispatch<React.SetStateAction<SimplePrefs>>;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setFileRefs: React.Dispatch<React.SetStateAction<string[]>>;
  setFileMention: React.Dispatch<React.SetStateAction<FileMention | null>>;
  setNotice: React.Dispatch<React.SetStateAction<(StatusNoticeProjection & { id: string }) | null>>;
  /** Show/dismiss the fallback model modal. */
  setFallbackPending?: React.Dispatch<React.SetStateAction<FallbackPendingProjection | null>>;
  setQueue: React.Dispatch<React.SetStateAction<QueuedItem[]>>;
  setRefineState: React.Dispatch<React.SetStateAction<RefineState | null>>;
  setPendingConfirm: React.Dispatch<React.SetStateAction<PendingConfirm | null>>;
  setSelectedAgentId: React.Dispatch<React.SetStateAction<string>>;
  setSessionStart: React.Dispatch<React.SetStateAction<number | null>>;
  setShowJumpToLatest: React.Dispatch<React.SetStateAction<boolean>>;
  setFileMatches: React.Dispatch<React.SetStateAction<string[]>>;
  setFilePickerIndex: React.Dispatch<React.SetStateAction<number>>;
  setFileSearching: React.Dispatch<React.SetStateAction<boolean>>;
  setAttachedImages: React.Dispatch<
    React.SetStateAction<Array<{ id: string; data: string; mime: string; name: string }>>
  >;
  setCopiedMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  setProviderLabels: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setDiffFiles: React.Dispatch<React.SetStateAction<FileEditMeta[] | null>>;
  resetAgentNameCache: () => void;
  /** Called when a run completes and the user has chime enabled. */
  onChime?: (() => void) | undefined;
  /** Called when session.start contains version/update info. */
  onUpdateInfo?:
    | ((info: { appVersion: string; latestVersion: string; updateAvailable: boolean }) => void)
    | undefined;

  // Stable callbacks provided by app.tsx
  /** Returns `true` when the message was dispatched, `false` when dropped
   *  (no session / empty content / no socket). Queue-drain callers gate on
   *  this so a dropped drain does not silently consume the queued item. */
  dispatchUserMessage: (
    content: string,
    images?: { data: string; mime: string; mediaType?: string }[],
  ) => boolean;
  requestProviderModels: (providerId: string) => void;
  writeComposerDraft: (sessionId: string, draft: { text: string; fileRefs: string[] }) => void;
  clearComposerDraft: (sessionId: string) => void;
  readComposerDraft: (sessionId: string) => { text: string; fileRefs: string[] };

  // External store
  worklists: WorklistStore;
}
