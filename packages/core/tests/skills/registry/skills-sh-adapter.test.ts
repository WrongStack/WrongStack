import { describe, expect, it } from 'vitest';
import {
  createSkillsShAdapter,
  DEFAULT_SKILLS_SH_URL,
  type SkillsShFetcher,
} from '../../../src/skills/registry/skills-sh-adapter.js';
import { FetchError, ParseError } from '../../../src/types/errors.js';

/**
 * skills.sh adapter — search + resolveInstallRef. HTTP is fully mocked via the
 * injectable `fetcher` (same DI pattern as prompt-installer's JsonFetcher),
 * mirroring how github-fetcher.test.ts stubs `globalThis.fetch`. No real
 * network is ever hit.
 */

const sampleHit = {
  name: 'react-pro',
  description: 'React 19 patterns',
  owner: 'octocat',
  repo: 'react-pro',
  installs: 1500,
  score: 88,
  updatedAt: '2026-06-01T00:00:00Z',
};

function jsonResponse(body: unknown): unknown {
  return body;
}

describe('createSkillsShAdapter', () => {
  it('uses the default base url when none given', () => {
    const a = createSkillsShAdapter();
    expect(a.id).toBe('skills.sh');
    expect(a.displayName).toBe('skills.sh');
  });

  it('strips a trailing slash from a custom base url', async () => {
    const seen: string[] = [];
    const fetcher: SkillsShFetcher = async (url) => {
      seen.push(url);
      return jsonResponse({ results: [] });
    };
    const a = createSkillsShAdapter({ baseUrl: 'https://hub.local////', fetcher });
    await a.search('x');
    expect(seen[0]).toMatch(/^https:\/\/hub\.local\/api\/skills/);
  });
});

describe('skills.sh adapter — search', () => {
  it('returns normalized summaries from a well-formed response', async () => {
    const fetcher: SkillsShFetcher = async () => jsonResponse({ results: [sampleHit] });
    const a = createSkillsShAdapter({ fetcher });
    const block = await a.search('react');
    expect(block.adapterId).toBe('skills.sh');
    expect(block.results).toHaveLength(1);
    const r = block.results[0]!;
    expect(r.name).toBe('react-pro');
    expect(r.author).toBe('octocat');
    expect(r.installs).toBe(1500);
    expect(r.securityScore).toBe(88);
    expect(r.installRef).toBe('octocat/react-pro');
  });

  it('appends @ref when the hit carries one', async () => {
    const fetcher: SkillsShFetcher = async () =>
      jsonResponse({ results: [{ ...sampleHit, ref: 'v2.0.0' }] });
    const a = createSkillsShAdapter({ fetcher });
    const block = await a.search('react');
    expect(block.results[0]?.installRef).toBe('octocat/react-pro@v2.0.0');
  });

  it('drops entries missing owner/repo (no install ref possible)', async () => {
    const fetcher: SkillsShFetcher = async () =>
      jsonResponse({
        results: [
          sampleHit,
          { name: 'orphan', description: 'no repo info' }, // no owner/repo
        ],
      });
    const a = createSkillsShAdapter({ fetcher });
    const block = await a.search('x');
    expect(block.results).toHaveLength(1);
    expect(block.results[0]?.name).toBe('react-pro');
  });

  it('returns empty for an empty query', async () => {
    const fetcher: SkillsShFetcher = async () => {
      throw new Error('should not be called');
    };
    const a = createSkillsShAdapter({ fetcher });
    const block = await a.search('   ');
    expect(block.results).toEqual([]);
    expect(block.hasMore).toBe(false);
  });

  it('sets hasMore when a full page is returned', async () => {
    const fullPage = Array.from({ length: 20 }, (_, i) => ({
      ...sampleHit,
      name: `skill-${i}`,
      repo: `repo-${i}`,
    }));
    const fetcher: SkillsShFetcher = async () => jsonResponse({ results: fullPage });
    const a = createSkillsShAdapter({ fetcher });
    const block = await a.search('x', { pageSize: 20 });
    expect(block.results).toHaveLength(20);
    expect(block.hasMore).toBe(true);
  });

  it('accepts alternative field names (slug, author, repository, installCount, starCount)', async () => {
    const fetcher: SkillsShFetcher = async () =>
      jsonResponse({
        results: [
          {
            slug: 'alt-skill',
            description: 'd',
            author: 'author-a',
            repository: 'repo-a',
            installCount: '42',
            starCount: 7,
          },
        ],
      });
    const a = createSkillsShAdapter({ fetcher });
    const block = await a.search('alt');
    const r = block.results[0];
    expect(r?.name).toBe('alt-skill');
    expect(r?.author).toBe('author-a');
    expect(r?.installRef).toBe('author-a/repo-a');
    expect(r?.installs).toBe(42);
    expect(r?.stars).toBe(7);
  });

  it('throws FetchError on a non-OK response (recoverable on 5xx)', async () => {
    const fetcher: SkillsShFetcher = async () => {
      throw new FetchError({ message: 'boom', status: 503 });
    };
    const a = createSkillsShAdapter({ fetcher });
    await expect(a.search('x')).rejects.toBeInstanceOf(FetchError);
  });

  it('returns empty results when the response is missing the results array (schema drift)', async () => {
    // Defensive: if skills.sh changes its response shape, we degrade to "no
    // matches" rather than crashing the whole command.
    const fetcher: SkillsShFetcher = async () => jsonResponse({ data: [] });
    const a = createSkillsShAdapter({ fetcher });
    const block = await a.search('x');
    expect(block.results).toEqual([]);
  });

  it('throws ParseError when the response is not an object at all', async () => {
    const fetcher: SkillsShFetcher = async () => jsonResponse(['not', 'an', 'object']);
    const a = createSkillsShAdapter({ fetcher });
    await expect(a.search('x')).rejects.toBeInstanceOf(ParseError);
  });
});

describe('skills.sh adapter — resolveInstallRef', () => {
  const a = createSkillsShAdapter({ fetcher: async () => ({ results: [] }) });

  it('passes owner/repo through unchanged', () => {
    expect(a.resolveInstallRef('octo/repo')).toBe('octo/repo');
  });

  it('keeps an explicit @ref', () => {
    expect(a.resolveInstallRef('octo/repo@v1.2.3')).toBe('octo/repo@v1.2.3');
  });

  it('throws ParseError on an empty id', () => {
    expect(() => a.resolveInstallRef('   ')).toThrow(ParseError);
  });

  it('throws ParseError on an id without owner/repo', () => {
    expect(() => a.resolveInstallRef('justoneword')).toThrow(ParseError);
    expect(() => a.resolveInstallRef('a/b/c')).toThrow(ParseError);
  });
});

describe('DEFAULT_SKILLS_SH_URL', () => {
  it('points at the canonical skills.sh host', () => {
    expect(DEFAULT_SKILLS_SH_URL).toBe('https://skills.sh');
  });
});
