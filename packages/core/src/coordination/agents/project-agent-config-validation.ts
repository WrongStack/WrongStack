import * as path from 'node:path';
import type { ProjectAgentConfig } from './project-agent-identity.js';

const PROJECT_AGENT_CONFIG_KEYS = new Set([
  'tools',
  'skillNames',
  'budget',
  'provider',
  'model',
  'allowedCapabilities',
  'modelPolicy',
  'fallbackProfile',
  'cwd',
  'worktree',
  'availability',
]);

const PROJECT_AGENT_BUDGET_KEYS = new Set([
  'timeoutMs',
  'idleTimeoutMs',
  'maxIterations',
  'maxToolCalls',
  'maxTokens',
  'maxCostUsd',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertStringList(value: unknown, field: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)
  ) {
    throw new Error(`Project agent config "${field}" must be an array of non-empty strings.`);
  }
}

/** Validate untrusted JSON before it can alter a roster agent runtime. */
export function validateProjectAgentConfig(value: unknown): ProjectAgentConfig {
  if (!isPlainRecord(value)) throw new Error('Project agent config must be an object.');

  const unknownKey = Object.keys(value).find((key) => !PROJECT_AGENT_CONFIG_KEYS.has(key));
  if (unknownKey) throw new Error(`Unknown project agent config field: "${unknownKey}".`);

  if (value.tools !== undefined) assertStringList(value.tools, 'tools');
  if (value.skillNames !== undefined) assertStringList(value.skillNames, 'skillNames');
  if (value.allowedCapabilities !== undefined) {
    assertStringList(value.allowedCapabilities, 'allowedCapabilities');
  }
  for (const field of ['provider', 'model', 'fallbackProfile'] as const) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && (typeof fieldValue !== 'string' || !fieldValue.trim())) {
      throw new Error(`Project agent config "${field}" must be a non-empty string.`);
    }
  }

  if (value.cwd !== undefined) {
    if (typeof value.cwd !== 'string' || !value.cwd.trim()) {
      throw new Error('Project agent config "cwd" must be a non-empty relative path.');
    }
    const cwd = value.cwd.replace(/\\/g, '/').trim();
    if (path.posix.isAbsolute(cwd) || /^[a-z]:\//i.test(cwd) || cwd.split('/').includes('..')) {
      throw new Error('Project agent config "cwd" must stay inside the assigned checkout.');
    }
    // Normalize before returning so the checked value is the value used at runtime.
    value.cwd = cwd;
  }
  if (
    value.worktree !== undefined &&
    value.worktree !== true &&
    value.worktree !== false &&
    value.worktree !== 'auto' &&
    value.worktree !== 'required' &&
    value.worktree !== 'off'
  ) {
    throw new Error('Project agent config "worktree" must be auto, required, off, or boolean.');
  }

  if (value.modelPolicy !== undefined) validateProjectAgentModelPolicy(value.modelPolicy);
  if (value.availability !== undefined) validateProjectAgentAvailability(value.availability);

  if (value.budget !== undefined) {
    if (!isPlainRecord(value.budget)) {
      throw new Error('Project agent config "budget" must be an object.');
    }
    const unknownBudgetKey = Object.keys(value.budget).find(
      (key) => !PROJECT_AGENT_BUDGET_KEYS.has(key),
    );
    if (unknownBudgetKey) {
      throw new Error(`Unknown project agent budget field: "${unknownBudgetKey}".`);
    }
    for (const [field, amount] of Object.entries(value.budget)) {
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
        throw new Error(`Project agent budget "${field}" must be a finite non-negative number.`);
      }
      if (field !== 'maxCostUsd' && !Number.isInteger(amount)) {
        throw new Error(`Project agent budget "${field}" must be an integer.`);
      }
    }
  }

  return value as ProjectAgentConfig;
}

function validateProjectAgentModelPolicy(value: unknown): void {
  if (!isPlainRecord(value)) throw new Error('Project agent modelPolicy must be an object.');
  const allowedKeys = new Set(['allowed', 'fallbacks', 'strict']);
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) throw new Error(`Unknown modelPolicy field: "${unknownKey}".`);

  const validateTargets = (targets: unknown, field: string, allowEmpty: boolean) => {
    if (!Array.isArray(targets) || (!allowEmpty && targets.length === 0)) {
      throw new Error(`Project agent modelPolicy "${field}" must be a non-empty array.`);
    }
    for (const target of targets) {
      if (
        !isPlainRecord(target) ||
        typeof target.provider !== 'string' ||
        !target.provider.trim() ||
        typeof target.model !== 'string' ||
        !target.model.trim()
      ) {
        throw new Error(`Project agent modelPolicy "${field}" contains an invalid target.`);
      }
    }
  };
  validateTargets(value.allowed, 'allowed', false);
  if (value.fallbacks !== undefined) {
    validateTargets(value.fallbacks, 'fallbacks', true);
    const allowed = new Set(
      (value.allowed as Array<{ provider: string; model: string }>).map(
        (target) => `${target.provider}\0${target.model}`,
      ),
    );
    for (const target of value.fallbacks as Array<{ provider: string; model: string }>) {
      if (!allowed.has(`${target.provider}\0${target.model}`)) {
        throw new Error('Every modelPolicy fallback must also appear in allowed.');
      }
    }
  }
  if (value.strict !== undefined && typeof value.strict !== 'boolean') {
    throw new Error('Project agent modelPolicy "strict" must be boolean.');
  }
}

function validateProjectAgentAvailability(value: unknown): void {
  if (!isPlainRecord(value)) throw new Error('Project agent availability must be an object.');
  const allowedKeys = new Set(['timezone', 'days', 'start', 'end', 'mode']);
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) throw new Error(`Unknown availability field: "${unknownKey}".`);
  if (typeof value.timezone !== 'string' || !value.timezone.trim()) {
    throw new Error('Project agent availability requires a timezone.');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.timezone }).format();
  } catch {
    throw new Error(`Invalid project agent availability timezone: "${value.timezone}".`);
  }
  if (
    !Array.isArray(value.days) ||
    value.days.length === 0 ||
    value.days.some((day) => !Number.isInteger(day) || (day as number) < 0 || (day as number) > 6)
  ) {
    throw new Error('Project agent availability days must contain weekday numbers 0-6.');
  }
  if (
    typeof value.start !== 'string' ||
    typeof value.end !== 'string' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.start) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.end)
  ) {
    throw new Error('Project agent availability start/end must use HH:MM.');
  }
  if (value.mode !== undefined && value.mode !== 'advisory' && value.mode !== 'enforce') {
    throw new Error('Project agent availability mode must be advisory or enforce.');
  }
}
