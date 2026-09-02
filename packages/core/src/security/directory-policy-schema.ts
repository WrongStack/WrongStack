import type { DirectoryPolicy, DirectoryRule } from '../types/permission.js';

export const DIRECTORY_POLICY_SCHEMA_VERSION = 1 as const;

export const DIRECTORY_POLICY_LIMITS = Object.freeze({
  maxRules: 500,
  maxDenyToolsPerRule: 256,
  maxDenyProvidersPerRule: 64,
  maxAllowOnlyToolsPerRule: 256,
  maxDirectoryChars: 4_096,
  maxDescriptionChars: 1_024,
  maxToolNameChars: 256,
  maxProviderIdChars: 128,
});

export type DirectoryPolicyDiagnosticCode =
  | 'invalid_root'
  | 'invalid_schema_version'
  | 'read_error'
  | 'too_many_rules'
  | 'invalid_rule'
  | 'unknown_field'
  | 'invalid_directory'
  | 'invalid_deny_tools'
  | 'invalid_deny_providers'
  | 'invalid_allow_only_tools'
  | 'too_many_deny_tools'
  | 'too_many_deny_providers'
  | 'too_many_allow_only_tools'
  | 'invalid_tool_name'
  | 'invalid_provider_id'
  | 'empty_rule'
  | 'duplicate_rule';

export interface DirectoryPolicyDiagnostic {
  severity: 'error' | 'warning';
  code: DirectoryPolicyDiagnosticCode;
  path: string;
  message: string;
}

export type DirectoryPolicyValidationResult =
  | { ok: true; policy: DirectoryPolicy; diagnostics: DirectoryPolicyDiagnostic[] }
  | { ok: false; diagnostics: DirectoryPolicyDiagnostic[] };

const RULE_FIELDS = new Set([
  'directory',
  'description',
  'denyTools',
  'denyProviders',
  'allowOnlyTools',
]);
const UNSAFE_PROPERTY_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function error(
  diagnostics: DirectoryPolicyDiagnostic[],
  code: DirectoryPolicyDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ severity: 'error', code, path, message });
}

/**
 * Validate and normalize a list of strings (tool names, provider ids, …).
 * Returns the cleaned list, or undefined if the value is not an array.
 * Diagnostics are accumulated in-place.
 */
function validateStringList(
  value: unknown,
  path: string,
  diagnostics: DirectoryPolicyDiagnostic[],
  limits: {
    maxItems: number;
    maxChars: number;
    itemLabel: string;
    listErrorCode: DirectoryPolicyDiagnosticCode;
    itemErrorCode: DirectoryPolicyDiagnosticCode;
    tooManyCode: DirectoryPolicyDiagnosticCode;
  },
): string[] | undefined {
  if (!Array.isArray(value)) {
    error(diagnostics, limits.listErrorCode, path, `must be an array of strings`);
    return undefined;
  }
  if (value.length > limits.maxItems) {
    error(
      diagnostics,
      limits.tooManyCode,
      path,
      `must contain at most ${limits.maxItems} ${limits.itemLabel}s`,
    );
    return undefined;
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > limits.maxChars) {
      error(
        diagnostics,
        limits.itemErrorCode,
        itemPath,
        `${limits.itemLabel} must be a non-empty string up to ${limits.maxChars} characters`,
      );
      continue;
    }
    if (UNSAFE_PROPERTY_NAMES.has(entry)) {
      error(
        diagnostics,
        limits.itemErrorCode,
        itemPath,
        `reserved name "${entry}" is not a valid ${limits.itemLabel}`,
      );
      continue;
    }
    if (seen.has(entry)) {
      diagnostics.push({
        severity: 'warning',
        code: 'duplicate_rule',
        path: itemPath,
        message: `duplicates an earlier entry and was normalized away`,
      });
      continue;
    }
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/**
 * Validate and normalize a single `DirectoryRule`.
 * Returns the cleaned rule or undefined when invalid.
 */
function validateRule(
  value: unknown,
  rulePath: string,
  diagnostics: DirectoryPolicyDiagnostic[],
): DirectoryRule | undefined {
  if (!isRecord(value)) {
    error(diagnostics, 'invalid_rule', rulePath, 'rule must be an object');
    return undefined;
  }

  const directory = value['directory'];
  if (
    typeof directory !== 'string' ||
    directory.length === 0 ||
    directory.length > DIRECTORY_POLICY_LIMITS.maxDirectoryChars
  ) {
    error(
      diagnostics,
      'invalid_directory',
      `${rulePath}.directory`,
      `must be a non-empty glob string up to ${DIRECTORY_POLICY_LIMITS.maxDirectoryChars} characters`,
    );
    return undefined;
  }

  for (const field of Object.keys(value)) {
    if (!RULE_FIELDS.has(field)) {
      error(
        diagnostics,
        'unknown_field',
        `${rulePath}.${field}`,
        `unknown directory policy field "${field}"`,
      );
    }
  }

  const description = value['description'];
  let normalizedDescription: string | undefined;
  if (description !== undefined) {
    if (
      typeof description !== 'string' ||
      description.length > DIRECTORY_POLICY_LIMITS.maxDescriptionChars
    ) {
      error(
        diagnostics,
        'invalid_rule',
        `${rulePath}.description`,
        `must be a string up to ${DIRECTORY_POLICY_LIMITS.maxDescriptionChars} characters`,
      );
    } else {
      normalizedDescription = description;
    }
  }

  const rule: DirectoryRule = { directory };
  if (normalizedDescription !== undefined) rule.description = normalizedDescription;

  if (value['denyTools'] !== undefined) {
    const denyTools = validateStringList(value['denyTools'], `${rulePath}.denyTools`, diagnostics, {
      maxItems: DIRECTORY_POLICY_LIMITS.maxDenyToolsPerRule,
      maxChars: DIRECTORY_POLICY_LIMITS.maxToolNameChars,
      itemLabel: 'tool name',
      listErrorCode: 'invalid_deny_tools',
      itemErrorCode: 'invalid_tool_name',
      tooManyCode: 'too_many_deny_tools',
    });
    if (denyTools) rule.denyTools = denyTools;
  }

  if (value['denyProviders'] !== undefined) {
    const denyProviders = validateStringList(
      value['denyProviders'],
      `${rulePath}.denyProviders`,
      diagnostics,
      {
        maxItems: DIRECTORY_POLICY_LIMITS.maxDenyProvidersPerRule,
        maxChars: DIRECTORY_POLICY_LIMITS.maxProviderIdChars,
        itemLabel: 'provider id',
        listErrorCode: 'invalid_deny_providers',
        itemErrorCode: 'invalid_provider_id',
        tooManyCode: 'too_many_deny_providers',
      },
    );
    if (denyProviders) rule.denyProviders = denyProviders;
  }

  if (value['allowOnlyTools'] !== undefined) {
    const allowOnlyTools = validateStringList(
      value['allowOnlyTools'],
      `${rulePath}.allowOnlyTools`,
      diagnostics,
      {
        maxItems: DIRECTORY_POLICY_LIMITS.maxAllowOnlyToolsPerRule,
        maxChars: DIRECTORY_POLICY_LIMITS.maxToolNameChars,
        itemLabel: 'tool name',
        listErrorCode: 'invalid_allow_only_tools',
        itemErrorCode: 'invalid_tool_name',
        tooManyCode: 'too_many_allow_only_tools',
      },
    );
    if (allowOnlyTools) rule.allowOnlyTools = allowOnlyTools;
  }

  const hasConstraint =
    (rule.denyTools?.length ?? 0) > 0 ||
    (rule.denyProviders?.length ?? 0) > 0 ||
    rule.allowOnlyTools !== undefined;
  if (!hasConstraint) {
    error(
      diagnostics,
      'empty_rule',
      rulePath,
      'rule must declare non-empty denyTools or denyProviders, or declare allowOnlyTools',
    );
    return undefined;
  }

  return rule;
}

/**
 * Validate and normalize a directory policy. Mirrors the shape and
 * diagnostics conventions of `validateTrustPolicy` so policy-inspector
 * UIs can render both files with a uniform error model.
 *
 * On invalid input the policy is reported with `ok: false` and the
 * original (untrusted) value is NOT surfaced — callers must treat the
 * returned policy as undefined when ok is false.
 */
export function validateDirectoryPolicy(value: unknown): DirectoryPolicyValidationResult {
  const diagnostics: DirectoryPolicyDiagnostic[] = [];
  if (!isRecord(value)) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'invalid_root',
          path: '$',
          message: 'directory policy must be an object',
        },
      ],
    };
  }

  const schemaVersion = value['schemaVersion'];
  if (schemaVersion !== DIRECTORY_POLICY_SCHEMA_VERSION) {
    error(
      diagnostics,
      'invalid_schema_version',
      '$.schemaVersion',
      `expected schemaVersion ${DIRECTORY_POLICY_SCHEMA_VERSION} but received ${JSON.stringify(schemaVersion)}`,
    );
    return { ok: false, diagnostics };
  }

  const rawRules = value['rules'];
  if (!Array.isArray(rawRules)) {
    error(diagnostics, 'invalid_root', '$.rules', 'rules must be an array');
    return { ok: false, diagnostics };
  }

  if (rawRules.length > DIRECTORY_POLICY_LIMITS.maxRules) {
    error(
      diagnostics,
      'too_many_rules',
      '$.rules',
      `must contain at most ${DIRECTORY_POLICY_LIMITS.maxRules} rules`,
    );
  }

  const rules: DirectoryRule[] = [];
  const seenDirectories = new Set<string>();
  for (const [index, rawRule] of rawRules.slice(0, DIRECTORY_POLICY_LIMITS.maxRules).entries()) {
    const rulePath = `$.rules[${index}]`;
    const rule = validateRule(rawRule, rulePath, diagnostics);
    if (!rule) continue;
    if (seenDirectories.has(rule.directory)) {
      diagnostics.push({
        severity: 'warning',
        code: 'duplicate_rule',
        path: rulePath,
        message: `another rule already targets directory "${rule.directory}"; entries are not merged (later rules do not extend earlier ones)`,
      });
      continue;
    }
    seenDirectories.add(rule.directory);
    rules.push(rule);
  }

  if (diagnostics.some((d) => d.severity === 'error')) {
    return { ok: false, diagnostics };
  }
  return {
    ok: true,
    policy: { schemaVersion: DIRECTORY_POLICY_SCHEMA_VERSION, rules },
    diagnostics,
  };
}
