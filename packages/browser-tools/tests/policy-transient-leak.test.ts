import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { describe, expect, it } from 'vitest';
import { browserPrivateOrigins, withTransientPrivateOrigin } from '../src/policy.js';

describe('withTransientPrivateOrigin error cleanup', () => {
  it('does not leak transient origin state when reading policy fails before fn runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-policy-leak-'));
    const policyDir = resolveWstackPaths({ projectRoot: root }).projectDir;
    const policyFile = join(policyDir, 'browser-policy.json');
    try {
      mkdirSync(policyDir, { recursive: true });
      writeFileSync(policyFile, '{corrupt json', 'utf8');
      await expect(
        withTransientPrivateOrigin(root, 'http://127.0.0.1:49999', async () => {}),
      ).rejects.toThrow();

      writeFileSync(policyFile, JSON.stringify({ privateOrigins: [] }), 'utf8');
      expect(browserPrivateOrigins(root)).not.toContain('http://127.0.0.1:49999');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(policyDir, { recursive: true, force: true });
    }
  });
});
