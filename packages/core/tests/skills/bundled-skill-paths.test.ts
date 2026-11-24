/**
 * Bundled skills' frontmatter `paths`: the Skill Companion holds an edit to a
 * matching file once for the skill, without a model. A loose glob costs the
 * leader a refused edit on unrelated work, so the declarations stay narrow
 * and this table pins what they match.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkillFrontmatter, validateSkillDocument } from '../../src/skills/frontmatter.js';
import { declaredPathMatch } from '../../src/skills/skill-path-rules.js';

const ROOT = join(__dirname, '..', '..', 'skills');
const skills = readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const raw = readFileSync(join(ROOT, entry.name, 'SKILL.md'), 'utf8');
    return { dir: entry.name, raw, paths: parseSkillFrontmatter(raw).paths };
  });

function claimants(file: string): string[] {
  return skills.filter((skill) => declaredPathMatch(skill, file, undefined)).map((s) => s.dir);
}

describe('bundled skill paths', () => {
  it('stay valid frontmatter', () => {
    for (const skill of skills.filter((s) => s.paths)) {
      expect(validateSkillDocument(skill.raw, skill.dir), skill.dir).toEqual([]);
      expect(skill.paths!.length, skill.dir).toBeGreaterThan(0);
    }
  });

  it.each([
    ['apps/edge/wrangler.jsonc', ['cloudflare-workers']],
    ['.github/workflows/ci.yml', ['ci-cd']],
    ['infra/main.tf', ['infrastructure-as-code']],
    ['docker/Dockerfile', ['docker-deploy']],
    ['docker-compose.prod.yml', ['compose-operations']],
    ['db/migrations/0001_init.sql', ['database-migrations', 'database-development']],
    ['src/schema.graphql', ['graphql-development']],
    ['src/pages/index.astro', ['astro-modern']],
    ['src/lib/Button.svelte', ['sveltekit-modern']],
    ['tsconfig.build.json', ['typescript-strict']],
    ['deploy/nginx/sites/app.conf', ['reverse-proxy-tls']],
    ['shaders/water.wgsl', ['threejs-3d']],
    ['DESIGN.md', ['design-system']],
    ['src/styles/design-tokens.css', ['design-system']],
    ['lib/theme/design_tokens.dart', ['design-system', 'flutter-mobile']],
    ['.design/brief.md', ['design-craft']],
  ])('%s → %j', (file, expected) => {
    expect(claimants(file)).toEqual(expect.arrayContaining(expected));
    expect(claimants(file)).toHaveLength(expected.length);
  });

  it.each([
    'src/app.ts',
    'src/components/Panel.tsx',
    'README.md',
    'package.json',
    'packages/core/src/index.ts',
    'tests/app.test.ts',
    'config.yaml',
    'src/index.css',
    'docs/brief.md',
  ])('claims no everyday file: %s', (file) => {
    expect(claimants(file)).toEqual([]);
  });
});

describe('declaredPathMatch without a project root', () => {
  const broad = { paths: ['*'] };

  it.each(['C:..\\evil.txt', 'C:evil.txt', '/etc/passwd'])(
    'rejects the non-project-relative path %s',
    (file) => {
      // A skill's declared paths may only cover project-relative files; a
      // drive-relative or absolute path escapes the project and must not match.
      expect(declaredPathMatch(broad, file, undefined)).toBeUndefined();
    },
  );

  it('still matches an ordinary project-relative file', () => {
    expect(declaredPathMatch(broad, 'src/app.ts', undefined)).toBe('*');
  });
});
