import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Module-relative so the suite passes from any vitest root (the package
// `test` script runs vitest with --root ../.. from the package directory).
const REPO_ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const repoFile = (path: string): string => readFileSync(resolve(REPO_ROOT, path), 'utf8');

describe('build command invariants', () => {
  it('documents the repository topological build runner in the docker-deploy skill', () => {
    const dockerSkill = repoFile('packages/core/skills/docker-deploy/SKILL.md');
    expect(dockerSkill).toContain('`pnpm build`');
    expect(dockerSkill).not.toContain('pnpm -r build');
  });
});
