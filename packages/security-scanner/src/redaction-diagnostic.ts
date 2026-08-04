import { DefaultSecretScrubber } from '@wrongstack/core/security';

export interface RedactionDiagnosticResult {
  redactedFields: string[];
  unchangedFields: string[];
}

// Fragment-assembled so the fixture source contains no complete secret-shaped
// token: the tooling secret scanner rewrites full tokens to already-redacted
// markers, which would silently re-break the fixture (markers pass through the
// scrubber untouched). At runtime these concatenate to realistic fakes the
// scrubber recognizes.
const SECRET_SHAPED_TAIL = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const MONGODB_URI_REST = 'user:pass@db.example.internal:27017/prod?authSource=admin';

/**
 * Raw synthetic secrets fed to the production scrubber. Exported so tests can
 * assert these values never leak across the diagnostic boundary (only field
 * paths are returned) without duplicating the literals and drifting.
 */
export const REDACTION_DIAGNOSTIC_RAW = {
  apiKey: 'sk-proj-' + SECRET_SHAPED_TAIL,
  githubToken: 'ghp_' + SECRET_SHAPED_TAIL,
  anthropicApiKey: 'sk-ant-api03-' + SECRET_SHAPED_TAIL,
  mongodbUri: 'mongodb://' + MONGODB_URI_REST,
} as const;

/**
 * Exercise the production secret scrubber with synthetic values and return
 * field names only. Raw sample values never cross this diagnostic boundary.
 */
export function runRedactionDiagnostic(): RedactionDiagnosticResult {
  // Realistic-shaped fakes, not markers: the scrubber anchor-pre-scans on
  // prefixes like `sk-` / `ghp_` / `sk-ant-` / `mongodb`, so an already
  // redacted marker (`[REDACTED:openai_key]`) would never trigger a match.
  const sample = {
    apiKey: REDACTION_DIAGNOSTIC_RAW.apiKey,
    githubToken: REDACTION_DIAGNOSTIC_RAW.githubToken,
    env: { ANTHROPIC_API_KEY: REDACTION_DIAGNOSTIC_RAW.anthropicApiKey },
    url: REDACTION_DIAGNOSTIC_RAW.mongodbUri,
    normal: 'this is not sensitive',
    // Non-string primitives pass through the scrubber untouched; the walker
    // skips them via the non-object guard instead of recursing.
    retries: 3,
    enabled: false,
    missing: undefined,
    nested: { port: 8080, flags: [1, 2, 3] },
  };
  const scrubbed = new DefaultSecretScrubber().scrubObject(sample);
  const redactedFields: string[] = [];
  const unchangedFields: string[] = [];

  function walk(prefix: string, before: unknown, after: unknown): void {
    if (typeof before === 'string' && typeof after === 'string') {
      (before === after ? unchangedFields : redactedFields).push(prefix);
      return;
    }
    if (!before || typeof before !== 'object' || !after || typeof after !== 'object') return;
    for (const key of Object.keys(before as Record<string, unknown>)) {
      walk(
        `${prefix}.${key}`,
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
      );
    }
  }

  walk('$', sample, scrubbed);
  return { redactedFields, unchangedFields };
}
