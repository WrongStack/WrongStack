/**
 * The prompt journal's agent-driven categories (clarify, delegation, autonomous next step),
 * recorded the same way by every host: the CLI and the standalone engine behind WebUI/desktop.
 */
export {
  createPromptJournalToolCallRecorder,
  type PromptJournalToolCallRecorder,
} from './prompt-journal/tool-call-recorder.js';
