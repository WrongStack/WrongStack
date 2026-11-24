import { ALLOWED_COLLAB_VERDICTS } from './input-validation/allow-lists.js';
import type { ValidationResult } from './input-validation/result.js';

export function validateCoordinationAction(
  action: { type: string; [key: string]: unknown },
  payload: { type: string; [key: string]: unknown },
): ValidationResult<Record<string, unknown>> {
  switch (payload.type) {
    // ── Goal ────────────────────────────────────────────────────────
    case 'goalRunInit': {
      const title = String(action.title ?? '');
      if (title.length > 500) {
        return { valid: false, error: `goalRunInit.title: exceeds 500 chars.` };
      }
      return { valid: true, value: payload };
    }

    case 'goalRunPhaseUpdate': {
      const completed = Number(action.completedTasks);
      if (!Number.isInteger(completed) || completed < 0) {
        return {
          valid: false,
          error: `goalRunPhaseUpdate.completedTasks: ${completed} is not a non-negative integer.`,
        };
      }
      const total = Number(action.totalTasks);
      if (!Number.isInteger(total) || total < 0) {
        return {
          valid: false,
          error: `goalRunPhaseUpdate.totalTasks: ${total} is not a non-negative integer.`,
        };
      }
      return { valid: true, value: payload };
    }

    case 'goalRunPhaseStatus': {
      if (typeof action.phaseId !== 'string' || !action.phaseId) {
        return { valid: false, error: 'goalRunPhaseStatus.phaseId: not a non-empty string.' };
      }
      if (typeof action.status !== 'string' || !action.status) {
        return { valid: false, error: 'goalRunPhaseStatus.status: not a non-empty string.' };
      }
      return { valid: true, value: payload };
    }

    case 'goalRunRunningPhases': {
      const phaseIds = action.phaseIds;
      if (!Array.isArray(phaseIds)) {
        return { valid: false, error: 'goalRunRunningPhases.phaseIds: not an array.' };
      }
      return { valid: true, value: payload };
    }

    case 'goalRunElapsed': {
      const ms = Number(action.ms);
      if (!Number.isFinite(ms) || ms < 0) {
        return { valid: false, error: `goalRunElapsed.ms: ${ms} is not a non-negative number.` };
      }
      return { valid: true, value: payload };
    }

    case 'goalRunTaskActive': {
      if (typeof action.active !== 'boolean') {
        return { valid: false, error: 'goalRunTaskActive.active: not a boolean.' };
      }
      return { valid: true, value: payload };
    }

    case 'goalRunTaskAgent': {
      if (typeof action.phaseId !== 'string' || !action.phaseId) {
        return { valid: false, error: 'goalRunTaskAgent.phaseId: not a non-empty string.' };
      }
      if (typeof action.taskId !== 'string' || !action.taskId) {
        return { valid: false, error: 'goalRunTaskAgent.taskId: not a non-empty string.' };
      }
      if (action.agent !== undefined && typeof action.agent !== 'string') {
        return { valid: false, error: 'goalRunTaskAgent.agent: not a string.' };
      }
      return { valid: true, value: payload };
    }

    case 'goalRunTaskCompleted': {
      if (typeof action.phaseId !== 'string' || !action.phaseId) {
        return {
          valid: false,
          error: 'goalRunTaskCompleted.phaseId: not a non-empty string.',
        };
      }
      if (typeof action.taskId !== 'string' || !action.taskId) {
        return { valid: false, error: 'goalRunTaskCompleted.taskId: not a non-empty string.' };
      }
      return { valid: true, value: payload };
    }

    // ── SDD board ───────────────────────────────────────────────────
    case 'sddBoardSnapshot': {
      if (!action.snapshot || typeof action.snapshot !== 'object') {
        return { valid: false, error: 'sddBoardSnapshot.snapshot: missing or non-object.' };
      }
      return { valid: true, value: payload };
    }

    // ── Worktree ────────────────────────────────────────────────────
    case 'worktreeUpsert': {
      const handleId = String(action.handleId ?? '');
      if (handleId.length === 0) {
        return { valid: false, error: 'worktreeUpsert.handleId: empty.' };
      }
      return { valid: true, value: payload };
    }

    case 'worktreeRemove': {
      const handleId = String(action.handleId ?? '');
      if (handleId.length === 0) {
        return { valid: false, error: 'worktreeRemove.handleId: empty.' };
      }
      return { valid: true, value: payload };
    }

    // ── Collaboration ───────────────────────────────────────────────
    case 'collabBugFound': {
      const bugId = String(action.bugId ?? '');
      if (bugId.length === 0) {
        return { valid: false, error: 'collabBugFound.bugId: empty.' };
      }
      return { valid: true, value: payload };
    }

    case 'collabSessionDone': {
      const verdict = String(action.verdict ?? '');
      if (!ALLOWED_COLLAB_VERDICTS.has(verdict)) {
        return {
          valid: false,
          error: `collabSessionDone.verdict: "${verdict}" not on allow-list.`,
        };
      }
      return { valid: true, value: payload };
    }

    case 'collabSubagentSpawned': {
      const role = String(action.role ?? '');
      if (role.length === 0) {
        return { valid: false, error: 'collabSubagentSpawned.role: empty.' };
      }
      return { valid: true, value: payload };
    }
    default:
      throw new Error('Unsupported action: ' + payload.type);
  }
}
