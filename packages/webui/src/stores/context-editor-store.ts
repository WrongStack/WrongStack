import { create } from 'zustand';
import type {
  ContextEditorMessage,
  ContextEditorMetrics,
  ContextEditorRemoval,
  ContextEditorRepairPreview,
  ContextEditorValidationError,
  ContextEditorWarning,
  ContextEditorConflict,
  ContextEditorDiagnostics,
} from '@/types/runtime';

type ContextEditorPhase =
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
  pairedAssistantIndices: number[];
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

interface ContextEditorState {
  phase: ContextEditorPhase;
  revision: string | null;
  messages: ContextEditorMessage[];
  readonlyContext: ReadonlyContext | null;
  messageBreakdown: MessageBreakdownEntry[];
  diagnostics: ContextEditorDiagnostics | null;
  removeMessages: Set<number>;
  /** Messages selected directly by the user, excluding required assistant pairing. */
  explicitRemoveMessages: Set<number>;
  removeRanges: ContextEditorRemoval[];
  validation: ValidationResult | null;
  appliedResult: AppliedResult | null;
  errorMessage: string | null;
}

interface ContextEditorActions {
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
  markRangeForRemoval: (removal: ContextEditorRemoval) => void;
  clearRemovals: () => void;
  beginValidation: () => void;
  beginApply: () => void;
  setValidation: (result: ValidationResult) => void;
  setApplied: (result: AppliedResult) => void;
  setError: (message: string | null) => void;
  resetToClean: () => void;
  /** Derive the proposed messages from snapshot minus removals. */
  getProposedMessages: () => ContextEditorMessage[];
}

type ContextEditorStore = ContextEditorState & ContextEditorActions;

function isToolResultMessage(message: ContextEditorMessage | undefined): boolean {
  return Boolean(
    message?.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.length > 0 &&
      message.content.every((block) => block.type === 'tool_result'),
  );
}

function findPairedAssistantIndices(
  messages: readonly ContextEditorMessage[],
  userIndex: number,
): number[] {
  if (messages[userIndex]?.role !== 'user' || isToolResultMessage(messages[userIndex])) return [];
  const paired: number[] = [];
  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === 'user' && !isToolResultMessage(message)) break;
    if (message?.role === 'assistant') paired.push(index);
  }
  return paired;
}

function pairedAssistantIndicesForState(state: ContextEditorState, userIndex: number): number[] {
  return (
    state.messageBreakdown.find((entry) => entry.index === userIndex)?.pairedAssistantIndices ??
    findPairedAssistantIndices(state.messages, userIndex)
  );
}

function deriveRemoveMessages(
  state: ContextEditorState,
  explicitRemoveMessages: ReadonlySet<number>,
  removeRanges: readonly ContextEditorRemoval[],
): Set<number> {
  const removeMessages = new Set(explicitRemoveMessages);
  state.messages.forEach((message, userIndex) => {
    if (
      message.role !== 'user' ||
      (!explicitRemoveMessages.has(userIndex) &&
        !removeRanges.some((removal) => removal.messageIndex === userIndex))
    ) {
      return;
    }
    for (const assistantIndex of pairedAssistantIndicesForState(state, userIndex)) {
      removeMessages.add(assistantIndex);
    }
  });
  return removeMessages;
}

function normalizeRanges(removals: ContextEditorRemoval[]): ContextEditorRemoval[] {
  const groups = new Map<string, ContextEditorRemoval[]>();
  for (const removal of removals) {
    const key = `${removal.messageIndex}:${removal.blockIndex ?? 'string'}`;
    groups.set(key, [...(groups.get(key) ?? []), removal]);
  }
  return [...groups.values()].flatMap((group) => {
    const sorted = group.sort((left, right) => (left.start ?? 0) - (right.start ?? 0));
    const merged: ContextEditorRemoval[] = [];
    for (const removal of sorted) {
      const previous = merged.at(-1);
      if (
        previous?.end !== undefined &&
        removal.start !== undefined &&
        removal.end !== undefined &&
        removal.start <= previous.end
      ) {
        previous.end = Math.max(previous.end, removal.end);
      } else {
        merged.push({ ...removal });
      }
    }
    return merged;
  });
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

function applyRangeRemoval(messages: ContextEditorMessage[], removal: ContextEditorRemoval): void {
  if (removal.start === undefined || removal.end === undefined) return;
  const message = messages[removal.messageIndex];
  if (!message) return;
  if (removal.blockIndex === undefined && typeof message.content === 'string') {
    message.content = message.content.slice(0, removal.start) + message.content.slice(removal.end);
    return;
  }
  if (!Array.isArray(message.content) || removal.blockIndex === undefined) return;
  const block = message.content[removal.blockIndex];
  if (block?.type !== 'text' || typeof block.text !== 'string') return;
  block.text = block.text.slice(0, removal.start) + block.text.slice(removal.end);
}

const initialState: ContextEditorState = {
  phase: 'closed',
  revision: null,
  messages: [],
  readonlyContext: null,
  messageBreakdown: [],
  diagnostics: null,
  removeMessages: new Set(),
  explicitRemoveMessages: new Set(),
  removeRanges: [],
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
      explicitRemoveMessages: new Set(),
    }),

  close: () => set({ ...initialState }),

  loadSnapshot: (payload) =>
    set((state) => {
      const preserveAppliedSuccess =
        state.phase === 'applied_success' && state.appliedResult !== null;
      return {
        phase: preserveAppliedSuccess ? 'applied_success' : 'clean_snapshot',
        revision: payload.revision,
        messages: payload.messages,
        readonlyContext: payload.readonlyContext,
        messageBreakdown: payload.messageBreakdown,
        diagnostics: payload.diagnostics,
        removeMessages: new Set(),
        explicitRemoveMessages: new Set(),
        removeRanges: [],
        validation: null,
        appliedResult: preserveAppliedSuccess ? state.appliedResult : null,
        errorMessage: null,
      };
    }),

  toggleRemoveMessage: (index) => {
    const state = get();
    if (state.phase === 'validating' || state.phase === 'applying') return;
    const explicitRemoveMessages = new Set(state.explicitRemoveMessages);
    const isRequiredAssistant =
      state.messages[index]?.role === 'assistant' &&
      state.messages.some(
        (message, userIndex) =>
          message.role === 'user' &&
          (state.explicitRemoveMessages.has(userIndex) ||
            state.removeRanges.some((removal) => removal.messageIndex === userIndex)) &&
          pairedAssistantIndicesForState(state, userIndex).includes(index),
      );
    if (isRequiredAssistant && state.removeMessages.has(index)) return;
    if (explicitRemoveMessages.has(index)) {
      explicitRemoveMessages.delete(index);
    } else {
      explicitRemoveMessages.add(index);
    }
    const removeRanges = state.removeRanges;
    const removeMessages = deriveRemoveMessages(state, explicitRemoveMessages, removeRanges);
    set({
      removeMessages,
      explicitRemoveMessages,
      removeRanges,
      phase: removeMessages.size > 0 || removeRanges.length > 0 ? 'dirty' : 'clean_snapshot',
      validation: null,
    });
  },

  markRangeForRemoval: (removal) => {
    const state = get();
    if (state.phase === 'validating' || state.phase === 'applying') return;
    if (state.explicitRemoveMessages.has(removal.messageIndex)) return;
    if (
      removal.start === undefined ||
      removal.end === undefined ||
      removal.start < 0 ||
      removal.end <= removal.start
    ) {
      return;
    }
    const message = state.messages[removal.messageIndex];
    let text: string | undefined;
    if (removal.blockIndex === undefined && typeof message?.content === 'string') {
      text = message.content;
    } else if (removal.blockIndex !== undefined && Array.isArray(message?.content)) {
      const block = message.content[removal.blockIndex];
      if (block?.type === 'text') text = block.text;
    }
    if (
      text === undefined ||
      removal.end > text.length ||
      splitsSurrogatePair(text, removal.start) ||
      splitsSurrogatePair(text, removal.end)
    ) {
      return;
    }

    const removeRanges = normalizeRanges([...state.removeRanges, removal]);
    const removeMessages = deriveRemoveMessages(state, state.explicitRemoveMessages, removeRanges);
    set({ removeMessages, removeRanges, phase: 'dirty', validation: null });
  },

  clearRemovals: () =>
    set({
      removeMessages: new Set(),
      explicitRemoveMessages: new Set(),
      removeRanges: [],
      phase: 'clean_snapshot',
      validation: null,
    }),

  beginValidation: () =>
    set({
      phase: 'validating',
      validation: null,
      errorMessage: null,
    }),

  beginApply: () =>
    set({
      phase: 'applying',
      errorMessage: null,
    }),

  setValidation: (result) =>
    set({
      validation: result,
      phase: result.conflict ? 'conflicted' : result.ok ? 'validated' : 'invalid',
      errorMessage: null,
    }),

  setApplied: (result) =>
    set({
      appliedResult: result,
      phase: 'applied_success',
      removeMessages: new Set(),
      explicitRemoveMessages: new Set(),
      removeRanges: [],
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
      explicitRemoveMessages: new Set(),
      removeRanges: [],
      validation: null,
      errorMessage: null,
    }),

  getProposedMessages: () => {
    const state = get();
    const messages = structuredClone(state.messages);
    for (const removal of [...state.removeRanges].sort(
      (left, right) => (right.start ?? 0) - (left.start ?? 0),
    )) {
      applyRangeRemoval(messages, removal);
    }
    return messages.filter((_, i) => !state.removeMessages.has(i));
  },
}));
