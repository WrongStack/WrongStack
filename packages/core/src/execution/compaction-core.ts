import { estimateMessageTokens } from '../utils/token-estimate.js';

export {
  buildSmartDigest,
  type ContentScore,
  extractText,
  hasLargeToolResult,
  hasToolUse,
  scoreMessage,
} from './compaction-scoring.js';

export {
  type AcknowledgedToolReceiptCollapse,
  type AcknowledgedToolResultElision,
  analyzeFileToolLifecycle,
  collapseAcknowledgedToolReceipts,
  compactionDebugEnabled,
  type CompactionMetrics,
  didFileMutationRun,
  eliseAcknowledgedToolResults,
  eliseOldToolResults,
  type EliseResult,
  emitCompactionMetrics,
  extractPathHints,
  type FileToolLifecycle,
  findPreserveStart,
  firstErrorLine,
  isElidedResultContent,
  isElidedToolInput,
  isFileMutationToolName,
  isReadToolName,
  normalizePathKey,
  readPathOf,
  safeToolResultString,
  sameFilePath,
  setCompactionDebugLogger,
  summarizeToolResultElision,
  summarizeToolUseInputElision,
} from './compaction-elision.js';

export {
  buildLosslessDigest,
  type DedupResult,
  dedupStaleReads,
  elideMessageToolIo,
  enforceHardBudget,
  findExchangeStart,
  findSafeBoundary,
  type HardBudgetResult,
  hasTextContent,
  headTailTruncate,
  truncateMessageText,
} from './compaction-budget.js';

export {
  CompactionSummaryCache,
  type CompactionSummaryCacheOptions,
  compactionSummaryKey,
  isPlaceholderSummary,
  PLACEHOLDER_SUMMARIES,
} from './compaction-summary-cache.js';

export const estimateMessages = estimateMessageTokens;
