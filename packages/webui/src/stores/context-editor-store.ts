import { create } from 'zustand';
import type {
  ContextEditorMessage,
  ContextEditorMetrics,
  ContextEditorRepairPreview,
  ContextEditorValidationError,
  ContextEditorWarning,
  ContextEditorConflict,
  ContextEditorDiagnostics,
} from '@/types/runtime';

export type ContextEditorPhase =
  | 'closed'
  | 'loading_snapshot'
  | 'clean_snapshot'
  | 'dirty'
  | 'validating'
  | 'validated'
  | 'invalid'
  | 'conflicted'
  | 'applying'
  | 'applied_success'
  | 'apply_failed';

interface ReadonlyContext {
  systemPromptTokens: number;
  toolSchemaTokens: number;
  toolCount: number;
  totalTokens: number;
  messageTokens: number;
}

interface MessageBreakdownEntry {
  index: number;
  role: 'user' | 'assistant' | 'system';
  tokens: number;
  preview: string;
  blockCount: number | null;
  warnings: ContextEditorWarning[];
}

interface ValidationResult {
  ok: boolean;
  before: ContextEditorMetrics;
  after?: ContextEditorMetrics | undefined;
  validationErrors: ContextEditorValidationError[];
  warnings: ContextEditorWarning[];
  repair: ContextEditorRepairPreview;
  conflict?: ContextEditorConflict | undefined;
}

interface AppliedResult {
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

export interface ContextEditorState {
  phase: ContextEditorPhase;
  revision: string | null;
  messages: ContextEditorMessage[];
  readonlyContext: ReadonlyContext | null;
  messageBreakdown: MessageBreakdownEntry[];
  diagnostics: ContextEditorDiagnostics | null;
  removeMessages: Set<number>;
  validation: ValidationResult | null;
  appliedResult: AppliedResult | null;
  errorMessage: string | null;
}

export interface ContextEditorActions {
  open: () => void;
  close: () => void;
  loadSnapshot: (payload: {
    revision: string;
    messages: ContextEditorMessage[];
    readonlyContext: ReadonlyContext;
    messageBreakdown: MessageBreakdownEntry[];
    diagnostics: ContextEditorDiagnostics;
  }) => void;
  toggleRemoveMessage: (index: number) => void;
  clearRemovals: () => void;
  setValidation: (result: ValidationResult) => void;
  setApplied: (result: AppliedResult) => void;
  setError: (message: string | null) => void;
  resetToClean: () => void;
  /** Derive the proposed messages from snapshot minus removals. */
  getProposedMessages: () => ContextEditorMessage[];
}

export type ContextEditorStore = ContextEditorState & ContextEditorActions;

const initialState: ContextEditorState = {
  phase: 'closed',
  revision: null,
  messages: [],
  readonlyContext: null,
  messageBreakdown: [],
  diagnostics: null,
  removeMessages: new Set(),
  validation: null,
  appliedResult: null,
  errorMessage: null,
};

export const useContextEditorStore = create<ContextEditorStore>((set, get) => ({
  ...initialState,

  open: () =>
    set({
      ...initialState,
      phase: 'loading_snapshot',
      removeMessages: new Set(),
    }),

  close: () => set({ ...initialState }),

  loadSnapshot: (payload) =>
    set({
      phase: 'clean_snapshot',
      revision: payload.revision,
      messages: payload.messages,
      readonlyContext: payload.readonlyContext,
      messageBreakdown: payload.messageBreakdown,
      diagnostics: payload.diagnostics,
      removeMessages: new Set(),
      validation: null,
      appliedResult: null,
      errorMessage: null,
    }),

  toggleRemoveMessage: (index) => {
    const next = new Set(get().removeMessages);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    set({ removeMessages: next, phase: next.size > 0 ? 'dirty' : 'clean_snapshot', validation: null });
  },

  clearRemovals: () =>
    set({
      removeMessages: new Set(),
      phase: 'clean_snapshot',
      validation: null,
    }),

  setValidation: (result) =>
    set({
      validation: result,
      phase: result.conflict
        ? 'conflicted'
        : result.ok
          ? 'validated'
          : 'invalid',
      errorMessage: null,
    }),

  setApplied: (result) =>
    set({
      appliedResult: result,
      phase: 'applied_success',
      removeMessages: new Set(),
      validation: null,
      errorMessage: null,
    }),

  setError: (message) =>
    set({
      errorMessage: message,
      phase: message ? 'apply_failed' : get().phase,
    }),

  resetToClean: () =>
    set({
      phase: 'clean_snapshot',
      removeMessages: new Set(),
      validation: null,
      errorMessage: null,
    }),

  getProposedMessages: () => {
    const state = get();
    return state.messages.filter((_, i) => !state.removeMessages.has(i));
  },
}));
