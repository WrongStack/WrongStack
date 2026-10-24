import { ToolValidationError } from '@wrongstack/contracts/types';

// ---------------------------------------------------------------------------
// migration_plan input contract: schema (with accepted aliases) and the
// alias resolution `execute` applies before planning.
// ---------------------------------------------------------------------------

export const MIGRATION_PLAN_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    packageName: {
      type: 'string',
      description: 'Name of the npm package or framework.',
    },
    package: { type: 'string', description: 'Alias for packageName.' },
    pkg: { type: 'string', description: 'Alias for packageName.' },
    name: { type: 'string', description: 'Alias for packageName.' },
    package_name: { type: 'string', description: 'Alias for packageName.' },
    dependency: { type: 'string', description: 'Alias for packageName.' },
    dep: { type: 'string', description: 'Alias for packageName.' },
    module: { type: 'string', description: 'Alias for packageName.' },
    fromVersion: {
      type: 'string',
      description: 'Current version, e.g. "1.2.3".',
    },
    from: { type: 'string', description: 'Alias for fromVersion.' },
    from_version: { type: 'string', description: 'Alias for fromVersion.' },
    currentVersion: { type: 'string', description: 'Alias for fromVersion.' },
    since: { type: 'string', description: 'Alias for fromVersion.' },
    start: { type: 'string', description: 'Alias for fromVersion.' },
    toVersion: {
      type: 'string',
      description: 'Target version, e.g. "2.0.0".',
    },
    to: { type: 'string', description: 'Alias for toVersion.' },
    to_version: { type: 'string', description: 'Alias for toVersion.' },
    targetVersion: { type: 'string', description: 'Alias for toVersion.' },
    until: { type: 'string', description: 'Alias for toVersion.' },
    end: { type: 'string', description: 'Alias for toVersion.' },
    scope: {
      type: 'string',
      description: 'Optional scope describing which parts of the project use the package.',
    },
    use_llm: {
      type: 'boolean',
      description:
        'Add evidence-bounded Council risk analysis with One Shot fallback. Overrides useLlm for this call.',
    },
    useLlm: { type: 'boolean', description: 'Alias for use_llm.' },
    use_ai: { type: 'boolean', description: 'Alias for use_llm.' },
    useAi: { type: 'boolean', description: 'Alias for use_llm.' },
  },
  // No top-level oneOf/allOf/anyOf: Anthropic-family endpoints reject a tool
  // whose input_schema carries a combinator at the root, and some Claude-bound
  // wires serve inputSchema verbatim (the WrongForge leader gateway lists the
  // whole registry; one offender fails every leader turn). The provider-wire
  // compactor strips a top-level combinator anyway, so it would carry no
  // information there either. `resolveMigrationPlanInput` remains the
  // authoritative validator: a payload missing a whole field group is
  // rejected there with a clear error.
};

/** Canonical migration_plan fields (a type literal so it casts to a record of aliases). */
export type MigrationPlanInput = {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  scope?: string | undefined;
  use_llm?: boolean | undefined;
};

/**
 * Resolve the canonical package/from/to fields (plus the raw use_llm alias
 * chain) from `input`, accepting every alias the schema advertises. Throws a
 * ToolValidationError naming the first missing field.
 */
export function resolveMigrationPlanInput(input: MigrationPlanInput): {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  rawUseLlm: unknown;
} {
  const raw = (input ?? {}) as Record<string, unknown>;
  const rawPackage =
    input.packageName ||
    raw['package'] ||
    raw['pkg'] ||
    raw['name'] ||
    raw['package_name'] ||
    raw['packageName'] ||
    raw['dependency'] ||
    raw['dep'] ||
    raw['module'];
  const rawFrom =
    input.fromVersion ||
    raw['from'] ||
    raw['from_version'] ||
    raw['fromVersion'] ||
    raw['currentVersion'] ||
    raw['since'] ||
    raw['start'];
  const rawTo =
    input.toVersion ||
    raw['to'] ||
    raw['to_version'] ||
    raw['toVersion'] ||
    raw['targetVersion'] ||
    raw['until'] ||
    raw['end'];
  const rawUseLlm = input.use_llm ?? raw['useLlm'] ?? raw['use_ai'] ?? raw['useAi'];
  const packageName = String(rawPackage ?? '').trim();
  const fromVersion = String(rawFrom ?? '').trim();
  const toVersion = String(rawTo ?? '').trim();
  if (!packageName || !fromVersion || !toVersion) {
    throw new ToolValidationError({
      message: 'packageName, fromVersion, and toVersion are required',
      field: !packageName ? 'packageName' : !fromVersion ? 'fromVersion' : 'toVersion',
    });
  }
  return { packageName, fromVersion, toVersion, rawUseLlm };
}
