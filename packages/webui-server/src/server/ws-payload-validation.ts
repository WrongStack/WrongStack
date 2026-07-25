import { FORBIDDEN_PROTO_KEYS } from '@wrongstack/core/utils';

type PayloadValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ModelSwitchPayload {
  provider: string;
  model: string;
}

export function validateModelSwitchPayload(
  payload: unknown,
): PayloadValidationResult<ModelSwitchPayload> {
  if (!isRecord(payload)) {
    return {
      ok: false,
      message: 'model.switch payload must be an object with string provider and model',
    };
  }
  const provider = payload['provider'];
  const model = payload['model'];
  if (typeof provider !== 'string' || provider.trim().length === 0) {
    return { ok: false, message: 'model.switch payload.provider must be a non-empty string' };
  }
  if (typeof model !== 'string' || model.trim().length === 0) {
    return { ok: false, message: 'model.switch payload.model must be a non-empty string' };
  }
  return { ok: true, value: { provider, model } };
}

interface PrefsUpdatePayload {
  prefs: Record<string, unknown>;
}

const AUTONOMY_VALUES = new Set(['off', 'suggest', 'auto', 'eternal', 'eternal-parallel']);

interface MailboxMessagesPayload {
  limit?: number;
  agentId?: string;
  unreadOnly?: boolean;
  incompleteOnly?: boolean;
}

export function validateMailboxMessagesPayload(
  payload: unknown,
): PayloadValidationResult<MailboxMessagesPayload | undefined> {
  if (payload === undefined) return { ok: true, value: undefined };
  if (!isRecord(payload)) {
    return { ok: false, message: 'mailbox.messages payload must be an object when provided' };
  }
  const limit = payload['limit'];
  const agentId = payload['agentId'];
  const unreadOnly = payload['unreadOnly'];
  const incompleteOnly = payload['incompleteOnly'];
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1)) {
    return {
      ok: false,
      message: 'mailbox.messages payload.limit must be a positive number when provided',
    };
  }
  if (agentId !== undefined && typeof agentId !== 'string') {
    return {
      ok: false,
      message: 'mailbox.messages payload.agentId must be a string when provided',
    };
  }
  if (unreadOnly !== undefined && typeof unreadOnly !== 'boolean') {
    return {
      ok: false,
      message: 'mailbox.messages payload.unreadOnly must be a boolean when provided',
    };
  }
  if (incompleteOnly !== undefined && typeof incompleteOnly !== 'boolean') {
    return {
      ok: false,
      message: 'mailbox.messages payload.incompleteOnly must be a boolean when provided',
    };
  }
  return {
    ok: true,
    value: {
      ...(limit !== undefined ? { limit: limit as number } : {}),
      ...(agentId !== undefined ? { agentId: agentId as string } : {}),
      ...(unreadOnly !== undefined ? { unreadOnly: unreadOnly as boolean } : {}),
      ...(incompleteOnly !== undefined ? { incompleteOnly: incompleteOnly as boolean } : {}),
    },
  };
}

interface MailboxAgentsPayload {
  onlineOnly?: boolean;
}

const MAILBOX_SEND_TYPES = new Set([
  'note',
  'ask',
  'assign',
  'steer',
  'btw',
  'broadcast',
  'status',
  'result',
  'review',
]);

export interface MailboxSendPayload {
  requestId: string;
  to: string;
  type: 'note' | 'ask' | 'assign' | 'steer' | 'btw' | 'broadcast' | 'status' | 'result' | 'review';
  audience: 'all' | 'leaders';
  subject: string;
  body: string;
  priority: 'low' | 'normal' | 'high';
  replyTo?: string | undefined;
}

export function validateMailboxSendPayload(
  payload: unknown,
): PayloadValidationResult<MailboxSendPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'mailbox.send payload must be an object' };
  }
  const requestId = payload['requestId'];
  const rawTo = payload['to'];
  const rawType = payload['type'];
  const rawAudience = payload['audience'];
  const rawSubject = payload['subject'];
  const rawBody = payload['body'];
  const rawPriority = payload['priority'];
  const rawReplyTo = payload['replyTo'];

  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    return { ok: false, message: 'mailbox.send payload.requestId must be a non-empty string' };
  }
  if (typeof rawTo !== 'string' || rawTo.trim().length === 0) {
    return { ok: false, message: 'mailbox.send payload.to must be a non-empty string' };
  }
  if (typeof rawType !== 'string' || !MAILBOX_SEND_TYPES.has(rawType)) {
    return {
      ok: false,
      message: 'mailbox.send payload.type must be a supported non-control message type',
    };
  }
  if (rawAudience !== 'all' && rawAudience !== 'leaders') {
    return { ok: false, message: 'mailbox.send payload.audience must be all or leaders' };
  }
  if (typeof rawSubject !== 'string' || rawSubject.trim().length === 0) {
    return { ok: false, message: 'mailbox.send payload.subject must be a non-empty string' };
  }
  if (typeof rawBody !== 'string' || rawBody.trim().length === 0) {
    return { ok: false, message: 'mailbox.send payload.body must be a non-empty string' };
  }
  if (rawPriority !== 'low' && rawPriority !== 'normal' && rawPriority !== 'high') {
    return { ok: false, message: 'mailbox.send payload.priority must be low, normal, or high' };
  }
  if (rawReplyTo !== undefined && typeof rawReplyTo !== 'string') {
    return { ok: false, message: 'mailbox.send payload.replyTo must be a string when provided' };
  }

  const type = rawType as MailboxSendPayload['type'];
  const to = type === 'broadcast' ? '*' : rawTo.trim();
  if ((type === 'assign' || type === 'steer') && (to === '*' || to.toLowerCase() === 'all')) {
    return {
      ok: false,
      message: `mailbox.send payload.type ${type} requires a specific recipient`,
    };
  }

  return {
    ok: true,
    value: {
      requestId: requestId.trim(),
      to,
      type,
      audience: rawAudience,
      subject: rawSubject.trim(),
      body: rawBody.trim(),
      priority: rawPriority,
      ...(rawReplyTo !== undefined ? { replyTo: rawReplyTo } : {}),
    },
  };
}

export function validateMailboxAgentsPayload(
  payload: unknown,
): PayloadValidationResult<MailboxAgentsPayload | undefined> {
  if (payload === undefined) return { ok: true, value: undefined };
  if (!isRecord(payload)) {
    return { ok: false, message: 'mailbox.agents payload must be an object when provided' };
  }
  const onlineOnly = payload['onlineOnly'];
  if (onlineOnly !== undefined && typeof onlineOnly !== 'boolean') {
    return {
      ok: false,
      message: 'mailbox.agents payload.onlineOnly must be a boolean when provided',
    };
  }
  return {
    ok: true,
    value: { ...(onlineOnly !== undefined ? { onlineOnly: onlineOnly as boolean } : {}) },
  };
}

interface MailboxPurgePayload {
  completedMaxAgeMs?: number;
  incompleteMaxAgeMs?: number;
}

export function validateMailboxPurgePayload(
  payload: unknown,
): PayloadValidationResult<MailboxPurgePayload | undefined> {
  if (payload === undefined) return { ok: true, value: undefined };
  if (!isRecord(payload)) {
    return { ok: false, message: 'mailbox.purge payload must be an object when provided' };
  }
  const completedMaxAgeMs = payload['completedMaxAgeMs'];
  const incompleteMaxAgeMs = payload['incompleteMaxAgeMs'];
  if (
    completedMaxAgeMs !== undefined &&
    (typeof completedMaxAgeMs !== 'number' ||
      !Number.isFinite(completedMaxAgeMs) ||
      completedMaxAgeMs < 0)
  ) {
    return {
      ok: false,
      message:
        'mailbox.purge payload.completedMaxAgeMs must be a non-negative number when provided',
    };
  }
  if (
    incompleteMaxAgeMs !== undefined &&
    (typeof incompleteMaxAgeMs !== 'number' ||
      !Number.isFinite(incompleteMaxAgeMs) ||
      incompleteMaxAgeMs < 0)
  ) {
    return {
      ok: false,
      message:
        'mailbox.purge payload.incompleteMaxAgeMs must be a non-negative number when provided',
    };
  }
  return {
    ok: true,
    value: {
      ...(completedMaxAgeMs !== undefined
        ? { completedMaxAgeMs: completedMaxAgeMs as number }
        : {}),
      ...(incompleteMaxAgeMs !== undefined
        ? { incompleteMaxAgeMs: incompleteMaxAgeMs as number }
        : {}),
    },
  };
}

interface BrainRiskPayload {
  level: string;
}

const BRAIN_RISK_VALUES = new Set(['off', 'low', 'medium', 'high', 'all']);

export function validateBrainRiskPayload(
  payload: unknown,
): PayloadValidationResult<BrainRiskPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'brain.risk payload must be an object with string level' };
  }
  const level = payload['level'];
  if (typeof level !== 'string' || !BRAIN_RISK_VALUES.has(level)) {
    return {
      ok: false,
      message: 'brain.risk payload.level must be one of off, low, medium, high, all',
    };
  }
  return { ok: true, value: { level } };
}

interface BrainAskPayload {
  question: string;
}

export function validateBrainAskPayload(
  payload: unknown,
): PayloadValidationResult<BrainAskPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'brain.ask payload must be an object with string question' };
  }
  const question = payload['question'];
  if (typeof question !== 'string' || question.trim().length === 0) {
    return { ok: false, message: 'brain.ask payload.question must be a non-empty string' };
  }
  return { ok: true, value: { question: question.trim() } };
}

interface BrainConfigSetPayload {
  patch: Record<string, unknown>;
}

export function validateBrainConfigSetPayload(
  payload: unknown,
): PayloadValidationResult<BrainConfigSetPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'brain.config.set payload must be an object with a patch object' };
  }
  const patch = payload['patch'];
  if (!isRecord(patch)) {
    // Field-level validation happens in BrainRuntime.apply(), which throws
    // BEFORE any live state changes — this only guards the envelope shape.
    return { ok: false, message: 'brain.config.set payload.patch must be an object' };
  }
  return { ok: true, value: { patch } };
}

interface AutonomySwitchPayload {
  mode: string;
}

export function validateAutonomySwitchPayload(
  payload: unknown,
): PayloadValidationResult<AutonomySwitchPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'autonomy.switch payload must be an object with string mode' };
  }
  const mode = payload['mode'];
  if (typeof mode !== 'string' || !AUTONOMY_VALUES.has(mode)) {
    return { ok: false, message: 'autonomy.switch payload.mode must be a valid autonomy mode' };
  }
  return { ok: true, value: { mode } };
}

interface PlanTemplateUsePayload {
  template: string;
}

export function validatePlanTemplateUsePayload(
  payload: unknown,
): PayloadValidationResult<PlanTemplateUsePayload> {
  if (!isRecord(payload)) {
    return {
      ok: false,
      message: 'plan.template_use payload must be an object with string template',
    };
  }
  const template = payload['template'];
  if (typeof template !== 'string' || template.trim().length === 0) {
    return { ok: false, message: 'plan.template_use payload.template must be a non-empty string' };
  }
  return { ok: true, value: { template } };
}
const CONTEXT_STRATEGY_VALUES = new Set(['hybrid', 'intelligent', 'selective']);
const CONTEXT_MODE_VALUES = new Set(['balanced', 'frugal', 'deep', 'archival']);
const TOKEN_SAVING_TIER_VALUES = new Set(['off', 'minimal', 'light', 'medium', 'aggressive']);
const ENHANCE_LANGUAGE_VALUES = new Set(['original', 'english']);
const LOG_LEVEL_VALUES = new Set(['debug', 'info', 'warn', 'error']);
const AUDIT_LEVEL_VALUES = new Set(['minimal', 'standard', 'full']);
const REASONING_MODE_VALUES = new Set(['auto', 'on', 'off']);
const REASONING_EFFORT_VALUES = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
const CACHE_TTL_VALUES = new Set(['default', '5m', '1h']);

const BOOLEAN_PREF_KEYS = new Set([
  'yolo',
  'chime',
  'confirmExit',
  'nextPrediction',
  'titleAnimation',
  'enhanceEnabled',
  'featureMcp',
  'featurePlugins',
  'featureMemory',
  'featureSkills',
  'featureModelsRegistry',
  'indexOnStart',
  'contextAutoCompact',
  'tgSessionEnd',
  'tgDelegate',
  'reasoningPreserve',
  'hqEnabled',
  'hqRawContent',
  'fallbackAuto',
  'favoriteModelsOnly',
  'breakerEnabled',
  'debugStream',
  // Chimera + auto-review master toggles
  'chimeraEnabled',
  'autoReviewEnabled',
  'showModelReasoning',
  // Display-only toggles (purely visual, persisted in localStorage via Zustand).
  'groupToolCalls',
  'showThinkingLogs',
]);

/** Keys whose value must be an array of strings (e.g. an ordered model list). */
const STRING_ARRAY_PREF_KEYS = new Set([
  'fallbackModels',
  'favoriteModels',
  // Auto-review explicit fallback chain (derived when fallbackProfile is unset;
  // surfaced for visibility/override).
  'autoReviewFallbackModels',
]);
const STRING_ARRAY_RECORD_PREF_KEYS = new Set(['fallbackProfiles']);
const ARRAY_PREF_KEYS = new Set([
  // Model availability schedule — array of ModelBlackoutRule objects.
  'modelAvailabilitySchedule',
]);
const MODEL_MATRIX_PREF_KEYS = new Set(['modelMatrix']);
// Object of booleans, e.g. { 'plugin-name': true }. Parity with the embedded
// server, which accepts `pluginsEnabled` and persists it to
// extensions.<name>.enabled — the standalone server rejected it as unknown.
const BOOLEAN_RECORD_PREF_KEYS = new Set(['pluginsEnabled']);

const NUMBER_PREF_KEYS = new Set([
  'autonomyDelayMs',
  'autoProceedMaxIterations',
  'maxIterations',
  'maxConcurrent',
  'enhanceDelayMs',
  'tgLongToolMs',
  'breakerAutoKillResetMs',
  // Chimera + auto-review numeric knobs
  'chimeraMaxFiles',
  'autoReviewDebounceMs',
  'autoReviewMaxFilesPerBatch',
  'autoReviewMaxConcurrentReviews',
]);

const STRING_PREF_KEYS = new Set([
  'hqUrl',
  'hqToken',
  'uiLocale',
  'thinkingWord',
  'refinerProvider',
  'refinerModel',
  'refinerFallbackProfile',
  // Chimera + auto-review override strings
  'chimeraProvider',
  'chimeraModel',
  'autoReviewProvider',
  'autoReviewModel',
  'autoReviewFallbackProfile',
]);

const ENUM_PREF_KEYS: Record<string, Set<string>> = {
  autonomy: AUTONOMY_VALUES,
  contextStrategy: CONTEXT_STRATEGY_VALUES,
  contextMode: CONTEXT_MODE_VALUES,
  tokenSavingTier: TOKEN_SAVING_TIER_VALUES,
  enhanceLanguage: ENHANCE_LANGUAGE_VALUES,
  logLevel: LOG_LEVEL_VALUES,
  auditLevel: AUDIT_LEVEL_VALUES,
  reasoningMode: REASONING_MODE_VALUES,
  reasoningEffort: REASONING_EFFORT_VALUES,
  cacheTtl: CACHE_TTL_VALUES,
  statuslineMode: new Set(['minimum', 'detailed', 'no-color']),
  animationStyle: new Set(['rainbow', 'wave', 'pulse', 'dots', 'breathe', 'cycle']),
  fsAccess: new Set(['unrestricted', 'project']),
  // Chimera autoFix + auto-review cascade threshold
  chimeraAutoFix: new Set(['off', 'ask', 'auto']),
  autoReviewCascadeOn: new Set(['off', 'critical', 'high']),
  fleetChatVerbosity: new Set(['off', 'full']),
};

function validateModelRuntimeValue(
  modelRuntime: Record<string, unknown>,
  path: string,
): string | null {
  const reasoning = modelRuntime['reasoning'];
  if (reasoning !== undefined) {
    if (!isRecord(reasoning)) return `${path}.reasoning must be an object when provided`;
    const mode = reasoning['mode'];
    const effort = reasoning['effort'];
    const preserve = reasoning['preserve'];
    if (mode !== undefined && (typeof mode !== 'string' || !REASONING_MODE_VALUES.has(mode))) {
      return `${path}.reasoning.mode must be one of: ${Array.from(REASONING_MODE_VALUES).join(', ')}`;
    }
    if (
      effort !== undefined &&
      (typeof effort !== 'string' || !REASONING_EFFORT_VALUES.has(effort))
    ) {
      return `${path}.reasoning.effort must be one of: ${Array.from(REASONING_EFFORT_VALUES).join(', ')}`;
    }
    if (preserve !== undefined && typeof preserve !== 'boolean') {
      return `${path}.reasoning.preserve must be a boolean when provided`;
    }
  }

  const cache = modelRuntime['cache'];
  if (cache !== undefined) {
    if (!isRecord(cache)) return `${path}.cache must be an object when provided`;
    const ttl = cache['ttl'];
    if (
      ttl !== undefined &&
      (typeof ttl !== 'string' || !CACHE_TTL_VALUES.has(ttl) || ttl === 'default')
    ) {
      return `${path}.cache.ttl must be one of: 5m, 1h`;
    }
  }

  const parameters = modelRuntime['parameters'];
  if (parameters !== undefined && !isRecord(parameters)) {
    return `${path}.parameters must be an object when provided`;
  }

  return null;
}

function validatePreferenceValue(key: string, value: unknown): string | null {
  if (BOOLEAN_PREF_KEYS.has(key)) {
    return typeof value === 'boolean' ? null : `prefs.update payload.${key} must be a boolean`;
  }
  if (NUMBER_PREF_KEYS.has(key)) {
    return typeof value === 'number' && Number.isFinite(value)
      ? null
      : `prefs.update payload.${key} must be a finite number`;
  }
  if (STRING_PREF_KEYS.has(key)) {
    return typeof value === 'string' ? null : `prefs.update payload.${key} must be a string`;
  }
  if (STRING_ARRAY_PREF_KEYS.has(key)) {
    return Array.isArray(value) && value.every((v) => typeof v === 'string')
      ? null
      : `prefs.update payload.${key} must be an array of strings`;
  }
  if (ARRAY_PREF_KEYS.has(key)) {
    return Array.isArray(value)
      ? null
      : `prefs.update payload.${key} must be an array`;
  }
  if (STRING_ARRAY_RECORD_PREF_KEYS.has(key)) {
    return isRecord(value) &&
      Object.values(value).every(
        (v) => Array.isArray(v) && v.every((item) => typeof item === 'string'),
      )
      ? null
      : `prefs.update payload.${key} must be an object of string arrays`;
  }
  if (BOOLEAN_RECORD_PREF_KEYS.has(key)) {
    if (!isRecord(value) || !Object.values(value).every((v) => typeof v === 'boolean')) {
      return `prefs.update payload.${key} must be an object of booleans`;
    }
    // The KEYS here are plugin names that get used as property keys downstream
    // (extensions.<name>.enabled), so they must be checked too — validating
    // only the values let `{"__proto__": true}` through to a write that
    // polluted Object.prototype. The persist layer guards as well; this
    // rejects loudly instead of silently dropping the entry.
    const badKey = Object.keys(value).find((k) => FORBIDDEN_PROTO_KEYS.has(k));
    if (badKey) {
      return `prefs.update payload.${key} contains a forbidden key: ${badKey}`;
    }
    return null;
  }
  if (MODEL_MATRIX_PREF_KEYS.has(key)) {
    if (!isRecord(value)) return `prefs.update payload.${key} must be an object`;
    for (const entry of Object.values(value)) {
      if (!isRecord(entry)) return `prefs.update payload.${key} entries must be objects`;
      const provider = entry['provider'];
      const model = entry['model'];
      const fallbackProfile = entry['fallbackProfile'];
      const modelRuntime = entry['modelRuntime'];
      if (provider !== undefined && typeof provider !== 'string') {
        return `prefs.update payload.${key}.provider must be a string when provided`;
      }
      if (model !== undefined && typeof model !== 'string') {
        return `prefs.update payload.${key}.model must be a string when provided`;
      }
      if (fallbackProfile !== undefined && typeof fallbackProfile !== 'string') {
        return `prefs.update payload.${key}.fallbackProfile must be a string when provided`;
      }
      if (modelRuntime !== undefined && !isRecord(modelRuntime)) {
        return `prefs.update payload.${key}.modelRuntime must be an object when provided`;
      }
      if (isRecord(modelRuntime)) {
        const runtimeError = validateModelRuntimeValue(
          modelRuntime,
          `prefs.update payload.${key}.modelRuntime`,
        );
        if (runtimeError) return runtimeError;
      }
      if (model === undefined && fallbackProfile === undefined && modelRuntime === undefined) {
        return `prefs.update payload.${key} entries require model, fallbackProfile, or modelRuntime`;
      }
    }
    return null;
  }
  const allowed = ENUM_PREF_KEYS[key];
  if (allowed) {
    return typeof value === 'string' && allowed.has(value)
      ? null
      : `prefs.update payload.${key} must be one of: ${Array.from(allowed).join(', ')}`;
  }
  return `prefs.update payload contains unknown preference key: ${key}`;
}

export function validatePrefsUpdatePayload(
  payload: unknown,
): PayloadValidationResult<PrefsUpdatePayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'prefs.update payload must be an object' };
  }
  for (const [key, value] of Object.entries(payload)) {
    const error = validatePreferenceValue(key, value);
    if (error) return { ok: false, message: error };
  }
  return { ok: true, value: { prefs: payload } };
}

interface SkillsCreatePayload {
  name: string;
  description: string;
  scope: 'project' | 'global';
}

export function validateSkillsCreatePayload(
  payload: unknown,
): PayloadValidationResult<SkillsCreatePayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'skills.create payload must be an object' };
  }
  const name = payload['name'];
  const description = payload['description'];
  const scope = payload['scope'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { ok: false, message: 'Skill name is required' };
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name.trim())) {
    return { ok: false, message: 'Skill name must be kebab-case (e.g. my-new-skill)' };
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    return { ok: false, message: 'Description/trigger is required' };
  }
  if (scope !== 'project' && scope !== 'global') {
    return { ok: false, message: 'skills.create payload.scope must be project or global' };
  }
  return { ok: true, value: { name, description, scope } };
}

interface SkillsEditPayload {
  name: string;
  body: string;
}

export function validateSkillsEditPayload(
  payload: unknown,
): PayloadValidationResult<SkillsEditPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'skills.edit payload must be an object' };
  }
  const name = payload['name'];
  const body = payload['body'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { ok: false, message: 'Skill name is required' };
  }
  if (typeof body !== 'string' || body.length === 0) {
    return { ok: false, message: 'Skill body is required' };
  }
  return { ok: true, value: { name, body } };
}

interface ProcessKillPayload {
  pid: number;
}

export function validateProcessKillPayload(
  payload: unknown,
): PayloadValidationResult<ProcessKillPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'process.kill payload must be an object with numeric pid' };
  }
  const pid = payload['pid'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return { ok: false, message: 'process.kill payload.pid must be a positive integer' };
  }
  return { ok: true, value: { pid } };
}

interface WorkingDirSetPayload {
  path: string;
}

export function validateWorkingDirSetPayload(
  payload: unknown,
): PayloadValidationResult<WorkingDirSetPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'working_dir.set payload must be an object with string path' };
  }
  const newPath = payload['path'];
  if (typeof newPath !== 'string' || newPath.trim().length === 0) {
    return { ok: false, message: 'working_dir.set payload.path must be a non-empty string' };
  }
  return { ok: true, value: { path: newPath } };
}

interface ModeSwitchPayload {
  id: string;
}

export function validateModeSwitchPayload(
  payload: unknown,
): PayloadValidationResult<ModeSwitchPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'mode.switch payload must be an object with string id' };
  }
  const id = payload['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    return { ok: false, message: 'mode.switch payload.id must be a non-empty string' };
  }
  return { ok: true, value: { id } };
}

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
  return { ok: true, value: { id } };
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
      id,
      name,
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
  if (name !== undefined && typeof name !== 'string') {
    return {
      ok: false,
      message: 'context.mode.update payload.name must be a string when provided',
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
      id,
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof description === 'string' ? { description } : {}),
      ...(validatedThresholds !== undefined ? { thresholds: validatedThresholds } : {}),
      ...(typeof preserveK === 'number' ? { preserveK } : {}),
      ...(typeof eliseThreshold === 'number' ? { eliseThreshold } : {}),
    },
  };
}

interface ShellOpenPayload {
  path: string;
  target?: 'file' | 'terminal';
}

export function validateShellOpenPayload(
  payload: unknown,
): PayloadValidationResult<ShellOpenPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'shell.open payload must be an object with string path' };
  }
  const path = payload['path'];
  if (typeof path !== 'string' || path.trim().length === 0) {
    return { ok: false, message: 'shell.open payload.path must be a non-empty string' };
  }
  const target = payload['target'];
  if (target !== undefined && target !== 'file' && target !== 'terminal') {
    return {
      ok: false,
      message: 'shell.open payload.target must be "file" or "terminal" when provided',
    };
  }
  return {
    ok: true,
    value: {
      path,
      ...(target !== undefined ? { target: target as 'file' | 'terminal' } : {}),
    },
  };
}

interface GitDiffPayload {
  path: string;
}

export function validateGitDiffPayload(payload: unknown): PayloadValidationResult<GitDiffPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'git.diff payload must be an object' };
  }
  const path = payload['path'];
  if (path === undefined || path === null) {
    return { ok: true, value: { path: '' } };
  }
  if (typeof path !== 'string') {
    return { ok: false, message: 'git.diff payload.path must be a string when provided' };
  }
  return { ok: true, value: { path } };
}

interface ProjectsAddPayload {
  root: string;
  name?: string;
}

export function validateProjectsAddPayload(
  payload: unknown,
): PayloadValidationResult<ProjectsAddPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'projects.add payload must be an object with string root' };
  }
  const root = payload['root'];
  if (typeof root !== 'string' || root.trim().length === 0) {
    return { ok: false, message: 'projects.add payload.root must be a non-empty string' };
  }
  const name = payload['name'];
  if (name !== undefined && typeof name !== 'string') {
    return { ok: false, message: 'projects.add payload.name must be a string when provided' };
  }
  return {
    ok: true,
    value: { root, ...(typeof name === 'string' ? { name } : {}) },
  };
}

interface ProjectsSelectPayload {
  root: string;
  name?: string;
}

export function validateProjectsSelectPayload(
  payload: unknown,
): PayloadValidationResult<ProjectsSelectPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'projects.select payload must be an object with string root' };
  }
  const root = payload['root'];
  if (typeof root !== 'string' || root.trim().length === 0) {
    return { ok: false, message: 'projects.select payload.root must be a non-empty string' };
  }
  const name = payload['name'];
  if (name !== undefined && typeof name !== 'string') {
    return { ok: false, message: 'projects.select payload.name must be a string when provided' };
  }
  return {
    ok: true,
    value: { root, ...(typeof name === 'string' ? { name } : {}) },
  };
}
