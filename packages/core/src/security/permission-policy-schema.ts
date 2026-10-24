import type { TrustPolicy } from '@wrongstack/contracts/types/permission';

export const TRUST_POLICY_SCHEMA_VERSION = 1 as const;

export const TRUST_POLICY_LIMITS = Object.freeze({
  maxTools: 1_000,
  maxPatternsPerRule: 1_000,
  maxToolNameChars: 256,
  maxPatternChars: 4_096,
});

/** Machine-readable schema for the existing unversioned trust.json payload. */
export const TRUST_POLICY_JSON_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://wrongstack.dev/schemas/trust-policy-v1.json',
  title: 'WrongStack Trust Policy',
  type: 'object',
  maxProperties: TRUST_POLICY_LIMITS.maxTools,
  propertyNames: {
    minLength: 1,
    maxLength: TRUST_POLICY_LIMITS.maxToolNameChars,
    not: { enum: ['__proto__', 'prototype', 'constructor'] },
  },
  additionalProperties: {
    type: 'object',
    additionalProperties: false,
    properties: {
      allow: {
        type: 'array',
        maxItems: TRUST_POLICY_LIMITS.maxPatternsPerRule,
        items: { type: 'string', minLength: 1, maxLength: TRUST_POLICY_LIMITS.maxPatternChars },
      },
      deny: {
        type: 'array',
        maxItems: TRUST_POLICY_LIMITS.maxPatternsPerRule,
        items: { type: 'string', minLength: 1, maxLength: TRUST_POLICY_LIMITS.maxPatternChars },
      },
      auto: { type: 'boolean' },
      trustWorkdir: { type: 'boolean' },
      allowUntil: { type: 'number' },
      denyPrivate: { type: 'boolean' },
    },
  },
} as const);

export type TrustPolicyDiagnosticCode =
  | 'invalid_root'
  | 'invalid_json'
  | 'read_error'
  | 'too_many_tools'
  | 'invalid_tool_name'
  | 'unsafe_tool_name'
  | 'invalid_rule'
  | 'unknown_field'
  | 'invalid_boolean'
  | 'invalid_pattern_list'
  | 'too_many_patterns'
  | 'invalid_pattern'
  | 'duplicate_pattern';

export interface TrustPolicyDiagnostic {
  severity: 'error' | 'warning';
  code: TrustPolicyDiagnosticCode;
  path: string;
  message: string;
}

export type TrustPolicyValidationResult =
  | { ok: true; policy: TrustPolicy; diagnostics: TrustPolicyDiagnostic[] }
  | { ok: false; diagnostics: TrustPolicyDiagnostic[] };

// `allowUntil` (W6 #9) must be listed here as well as in TRUST_POLICY_JSON_SCHEMA:
// this Set is the validator that actually runs, while the JSON schema constant is
// exported for editor/tooling use and is not consulted by validateTrustPolicy.
const RULE_FIELDS = new Set(['allow', 'deny', 'auto', 'trustWorkdir', 'denyPrivate', 'allowUntil']);
const UNSAFE_PROPERTY_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function error(
  diagnostics: TrustPolicyDiagnostic[],
  code: TrustPolicyDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ severity: 'error', code, path, message });
}

function validatePatterns(
  value: unknown,
  path: string,
  diagnostics: TrustPolicyDiagnostic[],
): string[] | undefined {
  if (!Array.isArray(value)) {
    error(diagnostics, 'invalid_pattern_list', path, 'must be an array of strings');
    return undefined;
  }
  if (value.length > TRUST_POLICY_LIMITS.maxPatternsPerRule) {
    error(
      diagnostics,
      'too_many_patterns',
      path,
      `must contain at most ${TRUST_POLICY_LIMITS.maxPatternsPerRule} patterns`,
    );
    return undefined;
  }

  const patterns: string[] = [];
  const seen = new Set<string>();
  for (const [index, pattern] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (
      typeof pattern !== 'string' ||
      pattern.length === 0 ||
      pattern.length > TRUST_POLICY_LIMITS.maxPatternChars
    ) {
      error(
        diagnostics,
        'invalid_pattern',
        itemPath,
        `must be a non-empty string up to ${TRUST_POLICY_LIMITS.maxPatternChars} characters`,
      );
      continue;
    }
    if (seen.has(pattern)) {
      diagnostics.push({
        severity: 'warning',
        code: 'duplicate_pattern',
        path: itemPath,
        message: 'duplicates an earlier pattern and was normalized away',
      });
      continue;
    }
    seen.add(pattern);
    patterns.push(pattern);
  }
  return patterns;
}

/**
 * Validate and normalize a trust policy. This is the canonical parser shared
 * by runtime enforcement and future policy-inspector/editor surfaces.
 */
export function validateTrustPolicy(value: unknown): TrustPolicyValidationResult {
  const diagnostics: TrustPolicyDiagnostic[] = [];
  if (!isRecord(value)) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'invalid_root',
          path: '$',
          message: 'trust policy must be an object',
        },
      ],
    };
  }

  const entries = Object.entries(value);
  if (entries.length > TRUST_POLICY_LIMITS.maxTools) {
    error(
      diagnostics,
      'too_many_tools',
      '$',
      `must contain at most ${TRUST_POLICY_LIMITS.maxTools} tool rules`,
    );
  }

  const policy: TrustPolicy = {};
  for (const [toolName, rawRule] of entries.slice(0, TRUST_POLICY_LIMITS.maxTools)) {
    const toolPath = `$[${JSON.stringify(toolName)}]`;
    if (toolName.length === 0 || toolName.length > TRUST_POLICY_LIMITS.maxToolNameChars) {
      error(
        diagnostics,
        'invalid_tool_name',
        toolPath,
        `tool name must be 1-${TRUST_POLICY_LIMITS.maxToolNameChars} characters`,
      );
      continue;
    }
    if (UNSAFE_PROPERTY_NAMES.has(toolName)) {
      error(
        diagnostics,
        'unsafe_tool_name',
        toolPath,
        'reserved object property names are not valid tool rules',
      );
      continue;
    }
    if (!isRecord(rawRule)) {
      error(diagnostics, 'invalid_rule', toolPath, 'tool rule must be an object');
      continue;
    }

    for (const field of Object.keys(rawRule)) {
      if (!RULE_FIELDS.has(field)) {
        error(
          diagnostics,
          'unknown_field',
          `${toolPath}.${field}`,
          `unknown policy field "${field}"`,
        );
      }
    }

    const rule: TrustPolicy[string] = {};
    for (const field of ['allow', 'deny'] as const) {
      if (rawRule[field] === undefined) continue;
      const patterns = validatePatterns(rawRule[field], `${toolPath}.${field}`, diagnostics);
      if (patterns) rule[field] = patterns;
    }
    for (const field of ['auto', 'trustWorkdir', 'denyPrivate'] as const) {
      const setting = rawRule[field];
      if (setting === undefined) continue;
      if (typeof setting !== 'boolean') {
        error(diagnostics, 'invalid_boolean', `${toolPath}.${field}`, 'must be a boolean');
      } else {
        rule[field] = setting;
      }
    }
    // W6 #9: `allowUntil` must be COPIED here, not merely listed in
    // RULE_FIELDS above. This loop is what decides the rule that actually
    // reaches the evaluator, and a field that is accepted but not copied is
    // silently dropped — which reads as "the policy is valid" while the
    // expiry never lands, so every timed rule behaves as if it were permanent.
    const allowUntil = rawRule.allowUntil;
    if (allowUntil !== undefined) {
      if (typeof allowUntil !== 'number' || !Number.isFinite(allowUntil)) {
        error(
          diagnostics,
          'invalid_rule',
          `${toolPath}.allowUntil`,
          'must be a finite epoch-ms number',
        );
      } else {
        rule.allowUntil = allowUntil;
      }
    }
    policy[toolName] = rule;
  }

  return diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ? { ok: false, diagnostics }
    : { ok: true, policy, diagnostics };
}
