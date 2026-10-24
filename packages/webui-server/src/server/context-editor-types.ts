import type { ContentBlock, Message } from '@wrongstack/contracts/types';

export type ContextEditorBlock = ContentBlock;

export interface ContextEditorMessage {
  role: Message['role'];
  content: string | ContextEditorBlock[];
  ts?: string | undefined;
}

export interface ContextEditorRemoval {
  messageIndex: number;
  blockIndex?: number | undefined;
  start?: number | undefined;
  end?: number | undefined;
}

export interface ContextEditorMetrics {
  messages: number;
  blocks: number;
  messageTokens: number;
  fullRequestTokens: number;
}

export interface ContextEditorDiagnostics {
  hasToolAdjacencyIssues: boolean;
  orphanToolUses: string[];
  orphanToolResults: string[];
  emptyMessages: number;
  thinkingBlocks: number;
  signedThinkingBlocks: number;
}

export interface ContextEditorRepairPreview {
  changed: boolean;
  removedToolUses: string[];
  removedToolResults: string[];
  removedMessages: number;
}

export interface ContextEditorValidationError {
  path: string;
  code: string;
  message: string;
}

export interface ContextEditorWarning {
  path?: string | undefined;
  code: string;
  severity: 'info' | 'warning' | 'danger';
  message: string;
}

export interface ContextEditorConflict {
  code: 'CONTEXT_REVISION_CONFLICT' | 'RUN_ACTIVE';
  message: string;
}

export interface ContextEditorValidationResult {
  ok: boolean;
  baseRevision: string;
  currentRevision: string;
  before: ContextEditorMetrics;
  after?: ContextEditorMetrics | undefined;
  validationErrors: ContextEditorValidationError[];
  warnings: ContextEditorWarning[];
  repair: ContextEditorRepairPreview;
  conflict?: ContextEditorConflict | undefined;
  messages?: Message[] | undefined;
}

export interface ContextEditorAppliedResult {
  previousRevision: string;
  revision: string;
  before: ContextEditorMetrics;
  after: ContextEditorMetrics;
  removed: {
    messages: number;
    blocks: number;
    toolUses: string[];
    toolResults: string[];
    emptyMessages: number;
  };
  warnings: ContextEditorWarning[];
}

export interface ContextEditorSnapshot {
  revision: string;
  messages: ContextEditorMessage[];
  readonlyContext: {
    systemPromptTokens: number;
    toolSchemaTokens: number;
    toolCount: number;
    totalTokens: number;
    messageTokens: number;
  };
  messageBreakdown: Array<{
    index: number;
    role: Message['role'];
    tokens: number;
    preview: string;
    blockCount: number | null;
    warnings: ContextEditorWarning[];
    pairedAssistantIndices: number[];
  }>;
  diagnostics: ContextEditorDiagnostics;
}
