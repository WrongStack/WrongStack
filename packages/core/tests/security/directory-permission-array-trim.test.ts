import type { AgentContext } from '@wrongstack/contracts/types/context';
import { describe, expect, it } from 'vitest';
import { resolveTargetPaths } from '../../src/security/directory-permission-matching.js';

describe('directory-permission-matching array path trimming', () => {
  it('trims padded paths and ignores whitespace-only entries in array inputs', () => {
    const ctx = {
      projectRoot: process.cwd(),
      workingDir: process.cwd(),
    } as AgentContext;
    expect(resolveTargetPaths({ paths: [' secrets/key.pem ', '   '] }, ctx)).toEqual([
      'secrets/key.pem',
    ]);
  });
});
