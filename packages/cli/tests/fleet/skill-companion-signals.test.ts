import { join } from 'node:path';
import {
  declaredPathMatch,
  expandBraces,
  parseSkillFrontmatter,
  validateSkillDocument,
} from '@wrongstack/core/skills';
import {
  editedPaths,
  evidenceSignature,
  fileFamily,
  parseSkillCompanionPick,
  rankSkillCandidates,
  workTerms,
} from '@wrongstack/fleet';
import { describe, expect, it } from 'vitest';

describe('Skill Companion signals', () => {
  it('expands brace groups, including nested ones', () => {
    expect(expandBraces('src/*.{ts,tsx}')).toEqual(['src/*.ts', 'src/*.tsx']);
    expect(expandBraces('{a,b{c,d}}.md')).toEqual(['a.md', 'bc.md', 'bd.md']);
    expect(expandBraces('plain/**')).toEqual(['plain/**']);
    expect(expandBraces('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}').length).toBeLessThanOrEqual(32);
  });

  it('matches declared globs project-relative, bare names in any directory', () => {
    const root = join('/', 'repo');
    const skill = { paths: ['wrangler.{toml,jsonc}', 'workers/**/*.ts'] };
    expect(declaredPathMatch(skill, 'apps/edge/wrangler.toml', root)).toBe('wrangler.{toml,jsonc}');
    expect(declaredPathMatch(skill, join(root, 'workers', 'api', 'index.ts'), root)).toBe(
      'workers/**/*.ts',
    );
    expect(declaredPathMatch(skill, './workers/index.ts', root)).toBe('workers/**/*.ts');
    expect(declaredPathMatch(skill, 'src/workers/index.ts', root)).toBeUndefined();
    // Outside the project, nothing a project skill declares applies.
    expect(declaredPathMatch(skill, join('/', 'other', 'wrangler.toml'), root)).toBeUndefined();
    expect(declaredPathMatch({}, 'wrangler.toml', root)).toBeUndefined();
    // A tool path is relative to the working directory, which may sit below the root.
    expect(declaredPathMatch(skill, 'api/index.ts', root, join(root, 'workers'))).toBe(
      'workers/**/*.ts',
    );
  });

  it('ranks by overlap, name over description, catalog order among equals', () => {
    const candidates = [
      { name: 'pdf', description: 'Generate PDF reports.' },
      { name: 'testing', description: 'Write and fix tests.' },
      { name: 'cloudflare', description: 'Workers, wrangler and edge deployment.' },
      { name: 'docx', description: 'Word documents.' },
    ];
    const terms = workTerms(['Ship the workers to Cloudflare'], ['wrangler.toml']);
    const ranked = rankSkillCandidates(candidates, terms, 3);
    expect(ranked.map((c) => c.name)).toEqual(['cloudflare', 'pdf', 'testing']);
    // Name hits first; "workers" and "Workers" meet on their stem.
    expect(ranked[0]!.match).toEqual(['cloudflare', 'workers', 'wrangler']);
    expect(ranked[1]!.match).toBeUndefined();
    expect(evidenceSignature(ranked)).toBe('cloudflare:cloudflare,workers,wrangler');
  });

  it('reads ecosystem terms from extensions and ignores filler words', () => {
    const terms = workTerms(['Please make the new one'], ['src/settings/Panel.tsx']);
    expect([...terms.values()]).toEqual(['settings', 'panel', 'tsx', 'react', 'component']);
    // A request the ranker cannot read leaves no evidence to dedupe on.
    expect(
      evidenceSignature(rankSkillCandidates([{ name: 'pdf', description: 'x' }], terms, 5)),
    ).toBe('');
  });

  it('parses frontmatter paths as a brace-safe string or a list', () => {
    const doc = (paths: string) => `---\nname: edge\ndescription: d\n${paths}\n---\nbody\n`;
    expect(parseSkillFrontmatter(doc('paths: "src/*.{ts,tsx}, wrangler.toml"')).paths).toEqual([
      'src/*.{ts,tsx}',
      'wrangler.toml',
    ]);
    expect(parseSkillFrontmatter(doc('paths:\n  - "**/*.sql"\n  - db/**')).paths).toEqual([
      '**/*.sql',
      'db/**',
    ]);
    expect(validateSkillDocument(doc('paths:\n  nested: true'), 'edge')).toContain(
      'paths must be a string or a list of strings',
    );
  });

  it('distinguishes high-signal config and workflow families from generic extensions', () => {
    expect(fileFamily('.github/workflows/ci.yml')).toBe('ci');
    expect(fileFamily('next.config.ts')).toBe('next-config');
    expect(fileFamily('tailwind.config.ts')).toBe('tailwind');
    expect(fileFamily('playwright.config.ts')).toBe('playwright');
    expect(fileFamily('vitest.config.ts')).toBe('vitest');
    expect(fileFamily('drizzle.config.ts')).toBe('drizzle');
    expect(fileFamily('wrangler.toml')).toBe('wrangler');
    expect(fileFamily('src/app.test.ts')).toBe('test');
    expect(fileFamily('tests/test_auth.py')).toBe('test');
    expect(fileFamily('Dockerfile.prod')).toBe('docker');
    expect(fileFamily('compose.yaml')).toBe('docker');
    expect(fileFamily('src/index.ts')).toBe('.ts');
  });

  it('extracts editedPaths from camelCase, target_file, paths[], and multi_edit edits[] inputs', () => {
    expect(editedPaths({ filePath: ' src/App.tsx ' }, undefined)).toEqual(['src/App.tsx']);
    expect(editedPaths({ target_file: 'workers/edge.ts' }, undefined)).toEqual(['workers/edge.ts']);
    expect(editedPaths({ paths: ['a.ts', 'b.tsx'] }, undefined)).toEqual(['a.ts', 'b.tsx']);
    expect(
      editedPaths(
        {
          edits: [{ file_path: 'src/one.ts' }, { filePath: 'src/two.ts' }, { path: 'src/one.ts' }],
        },
        undefined,
      ),
    ).toEqual(['src/one.ts', 'src/two.ts']);
  });

  it('extracts JSON picks even when prefaced by earlier brace blocks or fences', () => {
    const candidates = [{ name: 'cloudflare', description: 'Workers' }];
    const raw =
      'Context {"echo":1}\n```json\n{"skills":[{"name":"cloudflare","reason":"Workers deploy"}],"confidence":0.9}\n```';
    expect(parseSkillCompanionPick(raw, candidates)).toEqual({
      skills: [{ name: 'cloudflare', reason: 'Workers deploy' }],
      confidence: 0.9,
    });
  });
});
