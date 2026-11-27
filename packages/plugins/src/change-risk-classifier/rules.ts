import type { EvidenceRule } from '../evidence-analyzer/index.js';

/**
 * Content rules. On a pasted diff they see only changed lines of non-test
 * files (`keepNonTestChanges`): `token` in an unchanged context line, or
 * `DROP TABLE` inside a test fixture string, is not a risky change.
 */
export const CHANGE_RISK_RULES: readonly EvidenceRule[] = [
  {
    label: 'authentication or authorization change',
    severity: 'warning',
    pattern:
      /\b(?:authenticat\w*|authoriz\w*|permissions?|RBAC|ACL|jwt|oauth|csrf|login|logout|passwords?|access[_ -]?control|isAdmin|session[_ ]?cookie)\b/i,
    advice: 'Add positive and negative access-control regression coverage.',
  },
  {
    label: 'persistence or migration change',
    severity: 'warning',
    pattern:
      /\b(?:migrations?\b|ALTER\s+TABLE|CREATE\s+(?:TABLE|INDEX)|DROP\s+(?:COLUMN|INDEX)|RENAME\s+COLUMN|schema\.prisma|addColumn|dropColumn|createIndex)/i,
    advice: 'Prove upgrade, rollback, and existing-data behavior before release.',
  },
  {
    label: 'destructive operation',
    severity: 'error',
    pattern:
      /(?:\brm\s+-[a-z]*r[a-z]*f|\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\s+TABLE\b|\bdeleteAll\b|\bdeleteMany\(\s*\{\s*\}\s*\)|\bpush\s+(?:--force\b|-f\b)|\breset\s+--hard\b)/i,
    advice: 'Require an explicit target, backup/recovery plan, and review before execution.',
  },
];
