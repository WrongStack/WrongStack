import { TUI_CHECKPOINTS_MAX_ENTRIES } from './checkpoint-retention.js';

import { ALLOWED_CAPABILITY_FIELDS } from './input-validation/allow-lists.js';

import {
  MAX_CHAT_SEARCH_QUERY_CHARS,
  MAX_ENTRY_TEXT_CHARS,
  MAX_INPUT_BUFFER_CHARS,
} from './input-validation/limits.js';

import type { ValidationResult } from './input-validation/result.js';

import { validateCoordinationAction } from './input-validation-coordination.js';

import { MAX_TOOL_STREAM_RETAINED_CHARS } from './reducers/helpers.js';
export function validateDisplayAction(
  action: {
    type: string;
    [key: string]: unknown;
  },
  type: string,
  normalized: string,
  payload: { type: string; [key: string]: unknown },
): ValidationResult<Record<string, unknown>> {
  switch (normalized) {
    case 'setEffectiveMaxContext': {
      const ctx = Number(action.value);
      if (!Number.isInteger(ctx) || ctx < 0 || ctx > 10_000_000) {
        return {
          valid: false,
          error: `setEffectiveMaxContext.value: ${action.value} out of range [0, 10_000_000].`,
        };
      }
      return { valid: true, value: payload };
    }

    case 'setStreamingText': {
      const text = String(action.text ?? '');
      if (text.length > MAX_ENTRY_TEXT_CHARS) {
        return {
          valid: false,
          error: `setStreamingText.text: exceeds ${MAX_ENTRY_TEXT_CHARS.toLocaleString()} chars.`,
        };
      }
      return { valid: true, value: payload };
    }

    case 'setToolStream': {
      const text = String(action.text ?? '');
      if (text.length > MAX_TOOL_STREAM_RETAINED_CHARS) {
        return {
          valid: false,
          error: `setToolStream.text: exceeds ${MAX_TOOL_STREAM_RETAINED_CHARS.toLocaleString()} chars.`,
        };
      }
      return { valid: true, value: payload };
    }

    case 'setThinkingWord': {
      const word = String(action.word ?? '');
      if (word.length > 16) {
        return { valid: false, error: `setThinkingWord.word: "${word}" exceeds 16 chars.` };
      }
      return { valid: true, value: payload };
    }

    case 'setAnimationStyle': {
      const style = String(action.style ?? '');
      if (style.length > 50) {
        return {
          valid: false,
          error: `setAnimationStyle.style: length ${style.length} exceeds 50.`,
        };
      }
      return { valid: true, value: payload };
    }

    case 'setCapability': {
      const cap = action.capability;
      if (!cap || typeof cap !== 'object') {
        return { valid: false, error: 'setCapability.capability: missing or non-object.' };
      }
      // Verify known fields only
      for (const k of Object.keys(cap as Record<string, unknown>)) {
        if (!ALLOWED_CAPABILITY_FIELDS.has(k)) {
          return { valid: false, error: `setCapability.capability.${k}: unknown field.` };
        }
      }
      return { valid: true, value: payload };
    }

    // ── Confirm panels ──────────────────────────────────────────────
    case 'clearConfirmOpen':
    case 'exitConfirmOpen':
    case 'slashConfirmOpen':
    case 'escConfirmOpen':
    case 'enhanceConfirmOpen':
    case 'fallbackOverlayOpen': {
      const info = action.info;
      if (!info || typeof info !== 'object') {
        return { valid: false, error: `${type}.info: missing or non-object.` };
      }
      return { valid: true, value: payload };
    }

    case 'inspectOverlayOpen': {
      const entryId = Number(action.entryId);
      if (!Number.isInteger(entryId)) {
        return { valid: false, error: `${type}.entryId: not an integer.` };
      }
      const ids = action.entryIds;
      if (ids !== undefined) {
        if (!Array.isArray(ids) || ids.length > 64) {
          return { valid: false, error: `${type}.entryIds: invalid list.` };
        }
        if (ids.some((id) => !Number.isInteger(id))) {
          return { valid: false, error: `${type}.entryIds: every id must be an integer.` };
        }
      }
      return { valid: true, value: payload };
    }

    case 'chatSearchOpen':
    case 'chatSearchSetQuery': {
      if (typeof action.includeReasoning !== 'boolean') {
        return { valid: false, error: `${type}.includeReasoning: not a boolean.` };
      }
      const query = action.query;
      if (normalized === 'chatSearchOpen' && query === undefined) {
        return { valid: true, value: payload };
      }
      if (typeof query !== 'string' || query.length > MAX_CHAT_SEARCH_QUERY_CHARS) {
        return {
          valid: false,
          error: `${type}.query: not a string of at most ${MAX_CHAT_SEARCH_QUERY_CHARS} chars.`,
        };
      }
      return { valid: true, value: payload };
    }

    case 'chatSearchStep': {
      if (action.delta !== -1 && action.delta !== 1) {
        return { valid: false, error: `${type}.delta: must be -1 or 1.` };
      }
      if (typeof action.includeReasoning !== 'boolean') {
        return { valid: false, error: `${type}.includeReasoning: not a boolean.` };
      }
      return { valid: true, value: payload };
    }

    case 'messageJump': {
      if (action.direction !== -1 && action.direction !== 1) {
        return { valid: false, error: `${type}.direction: must be -1 or 1.` };
      }
      return { valid: true, value: payload };
    }

    case 'inspectOverlayScroll': {
      const delta = Number(action.delta);
      if (!Number.isInteger(delta) || delta < -10_000 || delta > 10_000) {
        return { valid: false, error: `${type}.delta: not a bounded integer.` };
      }
      return { valid: true, value: payload };
    }

    case 'clearConfirmSetValue': {
      const value = String(action.value ?? '');
      if (value.length > 100) {
        return { valid: false, error: `clearConfirmSetValue.value: exceeds 100 chars.` };
      }
      return { valid: true, value: payload };
    }

    // ── Checkpoints ─────────────────────────────────────────────────
    case 'checkpointReceived': {
      const cp = action.cp;
      if (!cp || typeof cp !== 'object') {
        return { valid: false, error: 'checkpointReceived.cp: missing or non-object.' };
      }
      const promptIndex = Number((cp as Record<string, unknown>).promptIndex);
      if (!Number.isInteger(promptIndex) || promptIndex < 0) {
        return {
          valid: false,
          error: `checkpointReceived.cp.promptIndex: ${promptIndex} is not a non-negative integer.`,
        };
      }
      return { valid: true, value: payload };
    }

    // ── Rewind ──────────────────────────────────────────────────────
    case 'rewindOverlayOpen': {
      const checkpoints = action.checkpoints;
      if (!Array.isArray(checkpoints)) {
        return { valid: false, error: 'rewindOverlayOpen.checkpoints: not an array.' };
      }
      if (checkpoints.length > TUI_CHECKPOINTS_MAX_ENTRIES) {
        return {
          valid: false,
          error: `rewindOverlayOpen.checkpoints: ${checkpoints.length} exceeds max ${TUI_CHECKPOINTS_MAX_ENTRIES}.`,
        };
      }
      return { valid: true, value: payload };
    }

    // ── Steering ────────────────────────────────────────────────────
    case 'setSteering': {
      const text = String(action.text ?? '');
      if (text.length > MAX_INPUT_BUFFER_CHARS) {
        return {
          valid: false,
          error: `setSteering.text: exceeds ${MAX_INPUT_BUFFER_CHARS.toLocaleString()} chars.`,
        };
      }
      return { valid: true, value: payload };
    }
    case 'goalRunInit':
    case 'goalRunPhaseUpdate':
    case 'goalRunRunningPhases':
    case 'goalRunElapsed':
    case 'goalRunTaskActive':
    case 'goalRunTaskAgent':
    case 'goalRunPhaseStatus':
    case 'goalRunTaskCompleted':
    case 'sddBoardSnapshot':
    case 'worktreeUpsert':
    case 'worktreeRemove':
    case 'collabBugFound':
    case 'collabSessionDone':
    case 'collabSubagentSpawned':
      return validateCoordinationAction(action, payload);

    // ── Debug stream ────────────────────────────────────────────────
    case 'debugStreamStats': {
      const chunkCount = Number(action.chunkCount);
      if (!Number.isInteger(chunkCount) || chunkCount < 0) {
        return {
          valid: false,
          error: `debugStreamStats.chunkCount: ${chunkCount} is not a non-negative integer.`,
        };
      }
      const lastChunkSize = Number(action.lastChunkSize);
      if (!Number.isInteger(lastChunkSize) || lastChunkSize < 0) {
        return {
          valid: false,
          error: `debugStreamStats.lastChunkSize: ${lastChunkSize} is not a non-negative integer.`,
        };
      }
      const totalBytes = Number(action.totalBytes);
      if (!Number.isInteger(totalBytes) || totalBytes < 0) {
        return {
          valid: false,
          error: `debugStreamStats.totalBytes: ${totalBytes} is not a non-negative integer.`,
        };
      }
      return { valid: true, value: payload };
    }

    // ── Countdown ───────────────────────────────────────────────────
    case 'countdownTick': {
      const remaining = Number(action.remainingSeconds);
      if (!Number.isFinite(remaining) || remaining < 0) {
        return {
          valid: false,
          error: `countdownTick.remainingSeconds: ${remaining} is not a non-negative number.`,
        };
      }
      return { valid: true, value: payload };
    }
  }
  return { valid: true, value: payload };
}
