import type { PayloadValidationResult } from './ws-validation-common.js';
import { isRecord } from './ws-validation-common.js';

interface ContextModeIdPayload {
  id: string;
}

function validateContextModeIdPayload(
  payload: unknown,
  type: 'context.mode.switch' | 'context.mode.delete',
): PayloadValidationResult<ContextModeIdPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: `${type} payload must be an object with string id` };
  }
  const id = payload['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    return { ok: false, message: `${type} payload.id must be a non-empty string` };
  }
  return { ok: true, value: { id: id.trim() } };
}

export function validateContextModeSwitchPayload(
  payload: unknown,
): PayloadValidationResult<ContextModeIdPayload> {
  return validateContextModeIdPayload(payload, 'context.mode.switch');
}

export function validateContextModeDeletePayload(
  payload: unknown,
): PayloadValidationResult<ContextModeIdPayload> {
  return validateContextModeIdPayload(payload, 'context.mode.delete');
}

interface ContextModeCreatePayload {
  id: string;
  name: string;
  description: string;
  thresholds: { warn: number; soft: number; hard: number };
  preserveK: number;
  eliseThreshold: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateContextModeCreatePayload(
  payload: unknown,
): PayloadValidationResult<ContextModeCreatePayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'context.mode.create payload must be an object' };
  }
  const id = payload['id'];
  const name = payload['name'];
  const description = payload['description'];
  const thresholds = payload['thresholds'];
  const preserveK = payload['preserveK'];
  const eliseThreshold = payload['eliseThreshold'];

  if (typeof id !== 'string' || id.trim().length === 0) {
    return { ok: false, message: 'context.mode.create payload.id must be a non-empty string' };
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { ok: false, message: 'context.mode.create payload.name must be a non-empty string' };
  }
  if (typeof description !== 'string') {
    return { ok: false, message: 'context.mode.create payload.description must be a string' };
  }
  if (!isRecord(thresholds)) {
    return {
      ok: false,
      message:
        'context.mode.create payload.thresholds must be an object with warn/soft/hard numbers',
    };
  }
  if (
    !isFiniteNumber(thresholds['warn']) ||
    !isFiniteNumber(thresholds['soft']) ||
    !isFiniteNumber(thresholds['hard'])
  ) {
    return {
      ok: false,
      message: 'context.mode.create payload.thresholds.warn/soft/hard must be finite numbers',
    };
  }
  if (!isFiniteNumber(preserveK)) {
    return { ok: false, message: 'context.mode.create payload.preserveK must be a finite number' };
  }
  if (!isFiniteNumber(eliseThreshold)) {
    return {
      ok: false,
      message: 'context.mode.create payload.eliseThreshold must be a finite number',
    };
  }
  return {
    ok: true,
    value: {
      id: id.trim(),
      name: name.trim(),
      description,
      thresholds: { warn: thresholds['warn'], soft: thresholds['soft'], hard: thresholds['hard'] },
      preserveK,
      eliseThreshold,
    },
  };
}

interface ContextModeUpdatePayload {
  id: string;
  name?: string;
  description?: string;
  thresholds?: { warn?: number; soft?: number; hard?: number };
  preserveK?: number;
  eliseThreshold?: number;
}

export function validateContextModeUpdatePayload(
  payload: unknown,
): PayloadValidationResult<ContextModeUpdatePayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'context.mode.update payload must be an object' };
  }
  const id = payload['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    return { ok: false, message: 'context.mode.update payload.id must be a non-empty string' };
  }

  const name = payload['name'];
  if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
    return {
      ok: false,
      message: 'context.mode.update payload.name must be a non-empty string when provided',
    };
  }

  const description = payload['description'];
  if (description !== undefined && typeof description !== 'string') {
    return {
      ok: false,
      message: 'context.mode.update payload.description must be a string when provided',
    };
  }

  const thresholds = payload['thresholds'];
  let validatedThresholds: ContextModeUpdatePayload['thresholds'];
  if (thresholds !== undefined) {
    if (!isRecord(thresholds)) {
      return {
        ok: false,
        message: 'context.mode.update payload.thresholds must be an object when provided',
      };
    }
    for (const key of ['warn', 'soft', 'hard'] as const) {
      const val = thresholds[key];
      if (val !== undefined && !isFiniteNumber(val)) {
        return {
          ok: false,
          message: `context.mode.update payload.thresholds.${key} must be a finite number when provided`,
        };
      }
    }
    validatedThresholds = {
      ...(typeof thresholds['warn'] === 'number' ? { warn: thresholds['warn'] } : {}),
      ...(typeof thresholds['soft'] === 'number' ? { soft: thresholds['soft'] } : {}),
      ...(typeof thresholds['hard'] === 'number' ? { hard: thresholds['hard'] } : {}),
    };
  }

  const preserveK = payload['preserveK'];
  if (preserveK !== undefined && !isFiniteNumber(preserveK)) {
    return {
      ok: false,
      message: 'context.mode.update payload.preserveK must be a finite number when provided',
    };
  }

  const eliseThreshold = payload['eliseThreshold'];
  if (eliseThreshold !== undefined && !isFiniteNumber(eliseThreshold)) {
    return {
      ok: false,
      message: 'context.mode.update payload.eliseThreshold must be a finite number when provided',
    };
  }

  return {
    ok: true,
    value: {
      id: id.trim(),
      ...(typeof name === 'string' ? { name: name.trim() } : {}),
      ...(typeof description === 'string' ? { description } : {}),
      ...(validatedThresholds !== undefined ? { thresholds: validatedThresholds } : {}),
      ...(typeof preserveK === 'number' ? { preserveK } : {}),
      ...(typeof eliseThreshold === 'number' ? { eliseThreshold } : {}),
    },
  };
}
