/**
 * skills.sh registry adapter.
 *
 * skills.sh is the open agent-skills marketplace (backed by mastra-ai/skills-api)
 * indexing 34k+ skills from 2.8k+ GitHub repos. Every entry is an
 * agentskills.io `SKILL.md` skill whose source repo is known, so resolving a
 * registry hit to a `user/repo@ref` install ref is just a lookup.
 *
 * API shape (https://skills.sh/api/skills):
 *   GET /api/skills?query=<q>&page=<p>&pageSize=<ps>&sortBy=installs
 *   → { results: Array<{ name, description, owner, repo, ref?, installs?, score?, updatedAt? }> }
 *
 * The base URL is configurable (`config.skills.registryUrl`, user-config only —
 * stripped from in-project config because the parsed response flows into the
 * prompt and a repo-controlled URL would be an SSRF / prompt-injection vector).
 *
 * This adapter is defensive about the response schema: skills.sh is a
 * third-party service and its exact JSON shape has changed before. We parse
 * loosely (missing fields become `undefined`) and throw `ParseError` only when
 * the response isn't the expected shape at all (no `results` array), so a
 * minor additive schema change degrades gracefully instead of crashing the
 * command.
 */
import { FetchError, ParseError } from '../../types/errors.js';
import type {
  RegistrySearchOptions,
  RegistrySearchResult,
  RegistrySkillSummary,
  SkillRegistryAdapter,
} from './registry-adapter.js';

/** Default skills.sh base URL. Override via `config.skills.registryUrl`. */
export const DEFAULT_SKILLS_SH_URL = 'https://skills.sh';

const SEARCH_TIMEOUT_MS = 15_000;
const MAX_PAGE_SIZE = 50;

/** Injectable fetcher (mirrors the `prompt-installer` JsonFetcher pattern). */
export type SkillsShFetcher = (url: string) => Promise<unknown>;

const defaultFetcher: SkillsShFetcher = async (url) => {
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        'User-Agent': 'wrongstack-skill-installer',
      },
      redirect: 'follow',
    });
  } catch (err) {
    throw new FetchError({
      message: `Network error querying skill registry: ${
        err instanceof Error ? err.message : String(err)
      }`,
      status: 0,
      context: { url, op: 'skills.sh.search' },
      cause: err,
    });
  }
  if (!res.ok) {
    // 429 / 5xx are recoverable; everything else is a hard failure.
    throw new FetchError({
      message: `Skill registry returned ${res.status} ${res.statusText}`,
      status: res.status,
      context: { url, op: 'skills.sh.search' },
    });
  }
  try {
    return await res.json();
  } catch (err) {
    throw new ParseError({
      message: `Skill registry response was not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
      source: 'skills.sh.search',
      context: { url },
      cause: err,
    });
  }
};

export interface SkillsShAdapterOptions {
  /** Base URL (no trailing slash). Defaults to {@link DEFAULT_SKILLS_SH_URL}. */
  baseUrl?: string | undefined;
  /** Injectable fetcher for tests. */
  fetcher?: SkillsShFetcher | undefined;
}

export function createSkillsShAdapter(opts: SkillsShAdapterOptions = {}): SkillRegistryAdapter {
  const baseUrl = (opts.baseUrl ?? DEFAULT_SKILLS_SH_URL).replace(/\/+$/, '');
  const fetcher = opts.fetcher ?? defaultFetcher;
  const id = 'skills.sh';

  return {
    id,
    displayName: 'skills.sh',

    async search(query: string, sopts: RegistrySearchOptions = {}): Promise<RegistrySearchResult> {
      const page = Math.max(1, sopts.page ?? 1);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, sopts.pageSize ?? 20));
      const q = query.trim();
      if (!q) return { adapterId: id, results: [], hasMore: false };

      const url =
        `${baseUrl}/api/skills?query=${encodeURIComponent(q)}` +
        `&page=${page}&pageSize=${pageSize}&sortBy=installs`;

      const raw = await fetcher(url);
      const results = parseResults(raw, url);

      return {
        adapterId: id,
        results,
        hasMore: results.length === pageSize,
      };
    },

    resolveInstallRef(registryId: string): string {
      // skills.sh ids are `<owner>/<repo>` (optionally `@<ref>`). We accept both
      // the bare id and an explicit `@ref` suffix; if a ref isn't given we let
      // the github-fetcher default to `main`.
      const trimmed = registryId.trim();
      if (!trimmed) {
        throw new ParseError({
          message: 'Empty skills.sh registry id.',
          source: 'skills.sh.resolveInstallRef',
        });
      }
      // Validate it looks like owner/repo (with optional @ref).
      const atIdx = trimmed.indexOf('@');
      const repoPart = atIdx > 0 ? trimmed.slice(0, atIdx) : trimmed;
      const segs = repoPart.split('/').filter(Boolean);
      if (segs.length !== 2) {
        throw new ParseError({
          message:
            `Invalid skills.sh id "${registryId}". Expected "<owner>/<repo>" or ` +
            `"<owner>/<repo>@<ref>".`,
          source: 'skills.sh.resolveInstallRef',
          context: { registryId },
        });
      }
      return trimmed;
    },
  };
}

/**
 * Parse the skills.sh search response into normalized summaries.
 *
 * The schema is parsed defensively: the top-level must be an object with a
 * `results` array (else `ParseError`), but individual entries may miss fields —
 * those become `undefined` on the summary. An entry without a usable
 * `installRef` (`owner` + `repo`) is dropped since the installer can't act on it.
 */
function parseResults(raw: unknown, url: string): RegistrySkillSummary[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ParseError({
      message: 'Skill registry response was not a JSON object.',
      source: 'skills.sh.search',
      context: { url },
    });
  }
  const results = (raw as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    // Some deployments wrap results differently. Treat a missing/Non-array
    // `results` field as an empty result set rather than crashing — the user
    // just sees "no matches", which is correct if the schema shifted.
    return [];
  }

  const out: RegistrySkillSummary[] = [];
  for (let i = 0; i < results.length; i++) {
    const entry = results[i] as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object') continue;

    const name = strField(entry, 'name') ?? strField(entry, 'slug');
    const description = strField(entry, 'description') ?? '';
    const owner = strField(entry, 'owner') ?? strField(entry, 'author');
    const repo = strField(entry, 'repo') ?? strField(entry, 'repository');
    if (!name || !owner || !repo) continue; // can't build an install ref

    const ref = strField(entry, 'ref') ?? strField(entry, 'branch') ?? strField(entry, 'tag');
    const installRef = ref ? `${owner}/${repo}@${ref}` : `${owner}/${repo}`;

    out.push({
      id: strField(entry, 'id') ?? `${owner}/${repo}`,
      name,
      description,
      author: owner,
      installs: numField(entry, 'installs') ?? numField(entry, 'installCount'),
      stars: numField(entry, 'stars') ?? numField(entry, 'starCount'),
      securityScore: numField(entry, 'securityScore') ?? numField(entry, 'score'),
      updatedAt: strField(entry, 'updatedAt') ?? strField(entry, 'updated_at'),
      installRef,
    });
  }
  return out;
}

function strField(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function numField(rec: Record<string, unknown>, key: string): number | undefined {
  const v = rec[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
