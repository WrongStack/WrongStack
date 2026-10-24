/** skills.sh search adapter. Uses /api/search and accepts legacy custom registry responses. */
import { FetchError, ParseError } from '@wrongstack/contracts/types/errors';
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
      const page = Number.isFinite(sopts.page) ? Math.max(1, Math.floor(sopts.page ?? 1)) : 1;
      const pageSize = Number.isFinite(sopts.pageSize)
        ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(sopts.pageSize ?? 20)))
        : 20;
      const q = query.trim();
      if (!q) return { adapterId: id, results: [], hasMore: false };

      const url = `${baseUrl}/api/search?q=${encodeURIComponent(q)}&limit=${Math.min(page * pageSize, MAX_PAGE_SIZE)}`;

      const raw = await fetcher(url);
      const allResults = parseResults(raw, url);
      const results = allResults.slice((page - 1) * pageSize, page * pageSize);

      return {
        adapterId: id,
        results,
        hasMore: results.length === pageSize && page * pageSize < MAX_PAGE_SIZE,
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
      // Validate it looks like owner/repo (with optional @ref and #skill).
      const hashIdx = trimmed.indexOf('#');
      const withoutSkill = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
      const skillFragment = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : '';
      const atIdx = withoutSkill.indexOf('@');
      const repoPart = atIdx > 0 ? withoutSkill.slice(0, atIdx) : withoutSkill;
      const refPart = atIdx > 0 ? withoutSkill.slice(atIdx + 1) : '';
      const segs = repoPart.split('/').filter(Boolean);
      if (segs.length === 3 && !skillFragment) {
        return `${segs[0]}/${segs[1]}${refPart ? `@${refPart}` : ''}#${segs[2]}`;
      }
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
  const results = (raw as { skills?: unknown }).skills ?? (raw as { results?: unknown }).results;
  if (!Array.isArray(results)) {
    throw new ParseError({
      message: 'Skill registry response is missing a skills/results array.',
      source: 'skills.sh.search',
      context: { url },
    });
  }

  const out: RegistrySkillSummary[] = [];
  for (let i = 0; i < results.length; i++) {
    const entry = results[i] as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object') continue;

    const name = strField(entry, 'name') ?? strField(entry, 'slug');
    const description = strField(entry, 'description') ?? '';
    const source = strField(entry, 'source')?.split('/');
    const owner = strField(entry, 'owner') ?? strField(entry, 'author') ?? source?.[0];
    const repo = strField(entry, 'repo') ?? strField(entry, 'repository') ?? source?.[1];
    if (!name || !owner || !repo) continue; // can't build an install ref

    const ref = strField(entry, 'ref') ?? strField(entry, 'branch') ?? strField(entry, 'tag');
    const skillId = strField(entry, 'skillId');
    const installRef =
      (ref ? `${owner}/${repo}@${ref}` : `${owner}/${repo}`) + (skillId ? `#${skillId}` : '');

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
