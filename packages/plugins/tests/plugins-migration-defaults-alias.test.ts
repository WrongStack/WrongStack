import { describe, expect, it } from 'vitest';
import { DEFAULTS, readConfig } from '../src/migration-planner/migration-config.js';

describe('migration-planner readConfig default array isolation (F2253)', () => {
  it('clones DEFAULTS.changelogPaths so caller mutations cannot corrupt defaults', () => {
    const cfg1 = readConfig(null);
    cfg1.changelogPaths.push('MUTATED.md');
    const cfg2 = readConfig({});
    expect(cfg2.changelogPaths).toEqual(['CHANGELOG.md']);
    expect(DEFAULTS.changelogPaths).toEqual(['CHANGELOG.md']);
  });
});
