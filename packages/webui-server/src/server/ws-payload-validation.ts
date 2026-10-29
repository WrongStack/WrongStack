import { validateSkillDocument, validateSkillName } from '@wrongstack/core/skills';
import type { PayloadValidationResult } from './ws-validation-common.js';
import { isRecord } from './ws-validation-common.js';

export {
  validateContextModeCreatePayload,
  validateContextModeDeletePayload,
  validateContextModeSwitchPayload,
  validateContextModeUpdatePayload,
} from './ws-context-validation.js';
export type { MailboxActionPayload, MailboxSendPayload } from './ws-mailbox-validation.js';
export {
  validateMailboxActionPayload,
  validateMailboxAgentsPayload,
  validateMailboxMessagesPayload,
  validateMailboxPurgePayload,
  validateMailboxSendPayload,
} from './ws-mailbox-validation.js';
export { validatePrefsUpdatePayload } from './ws-payload-preferences.js';
export { clampLimit } from './ws-validation-common.js';

interface ModelSwitchPayload {
  provider: string;
  model: string;
  requestId?: string | undefined;
  /**
   * The tab that asked. Every WebUI tab runs its own session with its own
   * model, so a switch applies to the requesting session's context — not to
   * whichever session the runtime last had in front.
   */
  sessionId?: string | undefined;
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
  const requestId = payload['requestId'];
  if (typeof provider !== 'string' || provider.trim().length === 0) {
    return { ok: false, message: 'model.switch payload.provider must be a non-empty string' };
  }
  if (typeof model !== 'string' || model.trim().length === 0) {
    return { ok: false, message: 'model.switch payload.model must be a non-empty string' };
  }
  if (requestId !== undefined && (typeof requestId !== 'string' || requestId.trim().length === 0)) {
    return { ok: false, message: 'model.switch payload.requestId must be a non-empty string' };
  }
  const sessionId = payload['sessionId'];
  return {
    ok: true,
    value: {
      provider: provider.trim(),
      model: model.trim(),
      ...(typeof requestId === 'string' ? { requestId: requestId.trim() } : {}),
      ...(typeof sessionId === 'string' && sessionId.trim().length > 0
        ? { sessionId: sessionId.trim() }
        : {}),
    },
  };
}

interface ModelFallbackChoicePayload {
  requestId: string;
  providerId?: string | undefined;
  model?: string | undefined;
  autoSwitch?: boolean | undefined;
}

export function validateModelFallbackChoicePayload(
  payload: unknown,
): PayloadValidationResult<ModelFallbackChoicePayload> {
  if (!isRecord(payload)) {
    return {
      ok: false,
      message: 'model.fallback_choice payload must be an object',
    };
  }
  const requestId = payload['requestId'];
  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    return {
      ok: false,
      message: 'model.fallback_choice payload.requestId must be a non-empty string',
    };
  }
  const providerId = payload['providerId'];
  const model = payload['model'];
  const autoSwitch = payload['autoSwitch'];
  if (providerId !== undefined && typeof providerId !== 'string') {
    return {
      ok: false,
      message: 'model.fallback_choice payload.providerId must be a string when provided',
    };
  }
  if (model !== undefined && typeof model !== 'string') {
    return {
      ok: false,
      message: 'model.fallback_choice payload.model must be a string when provided',
    };
  }
  if (autoSwitch !== undefined && typeof autoSwitch !== 'boolean') {
    return {
      ok: false,
      message: 'model.fallback_choice payload.autoSwitch must be a boolean when provided',
    };
  }
  return {
    ok: true,
    value: {
      requestId: requestId.trim(),
      ...(typeof providerId === 'string' ? { providerId } : {}),
      ...(typeof model === 'string' ? { model } : {}),
      ...(typeof autoSwitch === 'boolean' ? { autoSwitch } : {}),
    },
  };
}

const AUTONOMY_VALUES = new Set(['off', 'suggest', 'auto', 'eternal', 'eternal-parallel']);

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
  requestId?: string;
}

export function validateBrainAskPayload(
  payload: unknown,
): PayloadValidationResult<BrainAskPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'brain.ask payload must be an object with string question' };
  }
  const question = payload['question'];
  const requestId = payload['requestId'];
  if (requestId !== undefined && (typeof requestId !== 'string' || !requestId.trim())) {
    return { ok: false, message: 'brain.ask payload.requestId must be a non-empty string' };
  }
  if (typeof question !== 'string' || question.trim().length === 0) {
    return { ok: false, message: 'brain.ask payload.question must be a non-empty string' };
  }
  return {
    ok: true,
    value: {
      question: question.trim(),
      ...(typeof requestId === 'string' ? { requestId: requestId.trim() } : {}),
    },
  };
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
  if (validateSkillName(name.trim()).length > 0) {
    return { ok: false, message: 'Skill name must be kebab-case (e.g. my-new-skill)' };
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    return { ok: false, message: 'Description/trigger is required' };
  }
  if (description.trim().length > 1024)
    return { ok: false, message: 'Description must be at most 1024 characters' };
  if (scope !== 'project' && scope !== 'global') {
    return { ok: false, message: 'skills.create payload.scope must be project or global' };
  }
  return { ok: true, value: { name, description, scope } };
}

interface SkillsEditPayload {
  name: string;
  body: string;
  /** The text the editor read; the edit is refused when the file no longer matches it. */
  expectedBody?: string;
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
  const violations = validateSkillDocument(body, name.trim());
  if (violations.length) return { ok: false, message: violations.join('; ') };
  const expectedBody = payload['expectedBody'];
  if (expectedBody !== undefined && typeof expectedBody !== 'string')
    return { ok: false, message: 'expectedBody must be the text the editor read' };
  return {
    ok: true,
    value: { name, body, ...(expectedBody !== undefined ? { expectedBody } : {}) },
  };
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

interface ProcessOutputPayload {
  pid: number;
  lines: number;
}

/** `process.output`: a pid, and how many of its last output lines (1–200, default 40). */
export function validateProcessOutputPayload(
  payload: unknown,
): PayloadValidationResult<ProcessOutputPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'process.output payload must be an object with numeric pid' };
  }
  const pid = payload['pid'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return { ok: false, message: 'process.output payload.pid must be a positive integer' };
  }
  const lines = payload['lines'] ?? 40;
  if (typeof lines !== 'number' || !Number.isInteger(lines) || lines < 1 || lines > 200) {
    return { ok: false, message: 'process.output payload.lines must be an integer from 1 to 200' };
  }
  return { ok: true, value: { pid, lines } };
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

interface GitPathsPayload {
  paths: string[];
}

function parsePathsPayload(payload: unknown, op: string): PayloadValidationResult<GitPathsPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: `${op} payload must be an object` };
  }
  const single = payload['path'];
  const multi = payload['paths'];
  if (single !== undefined) {
    if (typeof single !== 'string') {
      return { ok: false, message: `${op} payload.path must be a string` };
    }
    return { ok: true, value: { paths: [single] } };
  }
  if (multi !== undefined) {
    if (!Array.isArray(multi) || multi.some((p) => typeof p !== 'string')) {
      return { ok: false, message: `${op} payload.paths must be an array of strings` };
    }
    return { ok: true, value: { paths: multi as string[] } };
  }
  return { ok: true, value: { paths: [] } };
}

export function validateGitStagePayload(
  payload: unknown,
): PayloadValidationResult<GitPathsPayload> {
  return parsePathsPayload(payload, 'git.stage');
}

export function validateGitUnstagePayload(
  payload: unknown,
): PayloadValidationResult<GitPathsPayload> {
  return parsePathsPayload(payload, 'git.unstage');
}

export function validateGitDiscardPayload(
  payload: unknown,
): PayloadValidationResult<GitPathsPayload> {
  return parsePathsPayload(payload, 'git.discard');
}

interface GitCommitPayload {
  message: string;
}

export function validateGitCommitPayload(
  payload: unknown,
): PayloadValidationResult<GitCommitPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'git.commit payload must be an object' };
  }
  const message = payload['message'];
  if (typeof message !== 'string' || message.trim().length === 0) {
    return { ok: false, message: 'git.commit payload.message must be a non-empty string' };
  }
  return { ok: true, value: { message: message.trim() } };
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

/**
 * `mcp.add` / `mcp.update` payload.
 *
 * WS-004: these handlers cast the raw WS payload with `as McpServerInput` and
 * passed it straight to `addMcp`, which persists `command`/`args`/`env` to the
 * global config and spawns them — so an unvalidated frame became a persistent
 * child process that respawns on every restart. Validate the shape and the
 * types before anything reaches disk.
 *
 * This checks structure, not policy: `command` is still whatever the operator
 * configures. The spawn itself is hardened separately by
 * `buildWin32CmdShimInvocation` (CMDI-005).
 */
interface McpServerPayload {
  name: string;
  [key: string]: unknown;
}

const MCP_MAX_STRING = 4_096;
const MCP_MAX_ARRAY = 256;
/**
 * The threshold keys `evaluateHealthThresholds` actually reads. It accesses
 * these four by name and never enumerates `Object.keys`, so extra keys in a
 * `health.thresholds` object are inert — this list is the whole attack surface,
 * and it is what makes the `health` check below precise rather than a broad
 * "must be a number-ish blob" rejection that would also break legitimate configs.
 */
const MCP_HEALTH_THRESHOLD_KEYS = [
  'connectionLatencyP95Ms',
  'discoveryLatencyP95Ms',
  'callLatencyP95Ms',
  'inFlightCalls',
] as const;

function isStringArray(value: unknown, max = MCP_MAX_ARRAY): boolean {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every((item) => typeof item === 'string' && item.length <= MCP_MAX_STRING)
  );
}

function isStringRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > MCP_MAX_ARRAY) return false;
  return entries.every(
    ([key, item]) =>
      typeof key === 'string' &&
      key.length <= MCP_MAX_STRING &&
      typeof item === 'string' &&
      item.length <= MCP_MAX_STRING,
  );
}

export function validateMcpServerPayload(
  payload: unknown,
  label: string,
): PayloadValidationResult<McpServerPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: `${label} payload must be an object` };
  }
  const name = payload['name'];
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > MCP_MAX_STRING) {
    return { ok: false, message: `${label} payload.name must be a non-empty string` };
  }

  for (const key of [
    'description',
    'command',
    'url',
    'transport',
    'permission',
    'bearerTokenEnv',
  ] as const) {
    const value = payload[key];
    if (value !== undefined && (typeof value !== 'string' || value.length > MCP_MAX_STRING)) {
      // `transport` also accepts an object form; only reject a bad primitive.
      if (!(key === 'transport' && isRecord(value))) {
        return { ok: false, message: `${label} payload.${key} must be a string` };
      }
    }
  }

  // `allowPrivateNetworks` is validated here, not just stored: `buildConfig`
  // copies it verbatim into the global config and the dial guard tests it for
  // TRUTHINESS to relax private/LAN routing. Any non-empty string (notably a
  // form-serialized "false") would therefore enable the relaxation while saying
  // the opposite, and persist across restarts.
  for (const key of ['enabled', 'lazy', 'allowPrivateNetworks'] as const) {
    const value = payload[key];
    if (value !== undefined && typeof value !== 'boolean') {
      return { ok: false, message: `${label} payload.${key} must be a boolean` };
    }
  }

  for (const key of ['args', 'allowedTools', 'passthroughEnv'] as const) {
    const value = payload[key];
    if (value !== undefined && !isStringArray(value)) {
      return { ok: false, message: `${label} payload.${key} must be an array of strings` };
    }
  }

  for (const key of ['env', 'headers'] as const) {
    const value = payload[key];
    if (value !== undefined && !isStringRecord(value)) {
      return {
        ok: false,
        message: `${label} payload.${key} must be an object of string values`,
      };
    }
  }

  // `health` is validated for the same reason as `allowPrivateNetworks`:
  // `buildConfig` copies it verbatim into the global config, and the four
  // threshold values are compared with `<=` inside `evaluateHealthThresholds`.
  // A non-numeric threshold makes every such comparison false (`NaN <= x`), so
  // `applyHealthThresholds` pins an otherwise-healthy server to `degraded`
  // permanently — and it persists across restarts. `null` also defeats the
  // `!== undefined` guard used by every other group in this function.
  const health = payload['health'];
  if (health !== undefined) {
    if (!isRecord(health)) {
      return { ok: false, message: `${label} payload.health must be an object` };
    }
    const thresholds = health['thresholds'];
    if (thresholds !== undefined) {
      if (!isRecord(thresholds)) {
        return { ok: false, message: `${label} payload.health.thresholds must be an object` };
      }
      for (const key of MCP_HEALTH_THRESHOLD_KEYS) {
        const value = thresholds[key];
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
          return {
            ok: false,
            message: `${label} payload.health.thresholds.${key} must be a finite number`,
          };
        }
      }
    }
  }

  return { ok: true, value: payload as McpServerPayload };
}
