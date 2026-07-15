export const SIMPLEUI_SURFACE = 'simpleui' as const;

// Chat model — content extraction & replay
export { contentToText, replayToMessages, updateSubagents } from './lib/chat-model.js';
export type { ChatMessage, SimpleSubagent } from './types.js';

// Clipboard — copy-to-clipboard with fallback
export type { ClipboardWriter } from './lib/clipboard.js';
export { copyText } from './lib/clipboard.js';

// Composer draft — per-session persistence
export type { ComposerDraft, DraftStorage } from './lib/composer-draft.js';
export { clearComposerDraft, readComposerDraft, writeComposerDraft } from './lib/composer-draft.js';

// File mention — @file picker protocol
export type { FileMention } from './lib/file-mention.js';
export { composePromptWithFileReferences, detectFileMention, fileBasename, removeFileMention } from './lib/file-mention.js';

// Message projection — next-steps parsing
export type { AssistantMessageProjection } from './lib/message-projection.js';
export { projectAssistantMessage } from './lib/message-projection.js';

// Session model — summaries & display names
export type { SimpleSessionSummary } from './types.js';
export { parseSessionSummaries, relativeSessionTime, sessionDisplayName } from './lib/session-model.js';

// Status notices — transient composer bar messages
export type { StatusNoticeProjection } from './lib/status-notice.js';
export { projectStatusNotice } from './lib/status-notice.js';

// Error boundary — isolated render crash handling
export { ErrorBoundary } from './error-boundary.js';
