/**
 * TechStack — OSV (Open Source Vulnerabilities) advisory client.
 *
 * Uses the OSV /v1/querybatch endpoint to batch-query vulnerability
 * information for lists of PackageURLs. Chunks requests into batches
 * of at most 500 packages per the OSV API limits.
 *
 * @see https://osv.dev/docs/
 */

import type { Evidence } from '../types.js';
import { parseJsonResponse, requestWithRetry } from '../registry/http-fetch.js';

// ── Types ─────────────────────────────────────────────────────────────────

/** OSV query batch request shape */
interface OsvQueryBatchRequest {
  readonly queries: ReadonlyArray<{
    readonly package: {
      readonly purl: string;
    };
  }>;
}

/** OSV query batch response shape */
interface OsvQueryBatchResponse {
  readonly results: ReadonlyArray<{
    readonly vulns?: ReadonlyArray<{
      readonly id: string;
      readonly summary?: string;
      readonly details?: string;
      readonly aliases?: readonly string[];
      readonly severity?: ReadonlyArray<{
        readonly type: string;
        readonly score: string;
      }>;
      readonly database_specific?: {
        readonly severity?: string;
      };
      readonly affected?: ReadonlyArray<{
        readonly database_specific?: {
          readonly severity?: string;
        };
      }>;
    }>;
  }>;
}

/** Parsed advisory for a single package */
export interface OsvAdvisory {
  readonly id: string;
  readonly summary: string;
  readonly severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  readonly aliases: readonly string[];
}

/** Result of querying OSV for a batch of packages */
export interface OsvBatchResult {
  /** Map from PURL to advisories found for that package */
  readonly advisories: Map<string, readonly OsvAdvisory[]>;
  readonly evidence: Evidence;
}

// ── Constants ──────────────────────────────────────────────────────────────

const OSV_API_BASE = 'api.osv.dev';
const OSV_QUERY_BATCH_PATH = '/v1/querybatch';
const MAX_BATCH_SIZE = 500;

// ── Severity mapping ───────────────────────────────────────────────────────

function mapSeverity(
  osvSeverity?: ReadonlyArray<{ readonly type: string; readonly score: string }>,
  databaseSeverity?: string,
): 'info' | 'low' | 'medium' | 'high' | 'critical' {
  // Check CVSS score first
  if (osvSeverity && osvSeverity.length > 0) {
    for (const s of osvSeverity) {
      if (s.type === 'CVSS_V3' || s.type === 'CVSS_V2') {
        const score = parseFloat(s.score);
        if (score >= 9.0) return 'critical';
        if (score >= 7.0) return 'high';
        if (score >= 4.0) return 'medium';
        if (score >= 0.1) return 'low';
      }
    }
  }

  // Check database_specific severity
  if (databaseSeverity) {
    const ds = databaseSeverity.toLowerCase();
    if (ds === 'critical') return 'critical';
    if (ds === 'high') return 'high';
    if (ds === 'medium' || ds === 'moderate') return 'medium';
    if (ds === 'low') return 'low';
  }

  return 'info';
}

// ── Core function ──────────────────────────────────────────────────────────

/**
 * Query OSV for advisories matching a list of PackageURLs.
 *
 * Chunks requests into batches of at most 500 PURLs per the OSV API limits.
 * Returns a map from each queried PURL to its list of advisories (empty array
 * means no advisories found).
 */
export async function queryOsvBatch(
  purls: readonly string[],
  options: { signal?: AbortSignal | undefined } = {},
): Promise<OsvBatchResult> {
  const advisories = new Map<string, readonly OsvAdvisory[]>();

  // Initialize empty arrays for all PURLs
  for (const purl of purls) {
    advisories.set(purl, []);
  }

  // Chunk PURLs into batches
  const batches: string[][] = [];
  for (let i = 0; i < purls.length; i += MAX_BATCH_SIZE) {
    batches.push(purls.slice(i, i + MAX_BATCH_SIZE));
  }

  for (const batch of batches) {
    const requestBody: OsvQueryBatchRequest = {
      queries: batch.map((purl) => ({
        package: { purl },
      })),
    };

    const jsonBody = JSON.stringify(requestBody);

    const response = await requestWithRetry({
      hostname: OSV_API_BASE,
      path: OSV_QUERY_BATCH_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(jsonBody).toString(),
        'User-Agent': 'WrongStack-TechStack/1.0',
      },
      body: jsonBody,
      signal: options.signal,
      timeoutMs: 30_000,
      maxAttempts: 3,
    });
    if (response.statusCode !== 200) {
      throw new Error(`OSV API returned ${response.statusCode}: ${response.body}`);
    }
    const result = parseJsonResponse<OsvQueryBatchResponse>(response, 'api.osv.dev/v1/querybatch');
    for (let i = 0; i < result.results.length; i++) {
      const purl = batch[i];
      if (!purl) continue;
      const vulns = result.results[i]?.vulns;
      if (!vulns || vulns.length === 0) continue;
      advisories.set(
        purl,
        vulns.map((vuln) => ({
          id: vuln.id,
          summary: vuln.summary ?? vuln.details ?? 'No summary available',
          severity: mapSeverity(
            vuln.severity,
            vuln.database_specific?.severity ?? vuln.affected?.[0]?.database_specific?.severity,
          ),
          aliases: vuln.aliases ?? [],
        })),
      );
    }
  }

  const evidence: Evidence = {
    kind: 'osv',
    source: 'https://api.osv.dev/v1/querybatch',
    retrievedAt: new Date().toISOString(),
    detail: `Queried ${purls.length} packages in ${batches.length} batch(es)`,
  };

  return { advisories, evidence };
}

/**
 * Query OSV for a single PURL.
 * Convenience wrapper around queryOsvBatch.
 */
export async function queryOsvSingle(
  purl: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<readonly OsvAdvisory[]> {
  const result = await queryOsvBatch([purl], options);
  return result.advisories.get(purl) ?? [];
}
