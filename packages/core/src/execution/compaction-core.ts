import { estimateMessageTokens } from '../utils/token-estimate.js';

export {
  type ContentScore,
  buildSmartDigest,
  extractText,
  hasLargeToolResult,
  hasToolUse,
  scoreMessage,
} from './compaction-scoring.js';

export {
  type EliseResult,
  collapseAcknowledgedToolReceipts,
  eliseAcknowledgedToolResults,
  eliseOldToolResults,
  findPreserveStart,
  isElidedResultContent,
  isElidedToolInput,
  normalizePathKey,
  readPathOf,
  setCompactionDebugLogger,
  summarizeToolResultElision,
  summarizeToolUseInputElision,
} from './compaction-elision.js';

export { buildLosslessDigest, dedupStaleReads, elideMessageToolIo, enforceHardBudget, findExchangeStart, findSafeBoundary, hasTextContent, headTailTruncate, truncateMessageText } from './compaction-budget.js';;

export { CompactionSummaryCache, compactionSummaryKey, isPlaceholderSummary, PLACEHOLDER_SUMMARIES } from './compaction-summary-cache.js';;

export const estimateMessages = estimateMessageTokens;
