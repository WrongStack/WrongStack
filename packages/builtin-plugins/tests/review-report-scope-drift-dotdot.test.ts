import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeReportScopeDrift } from '../src/review-report-integration.js';

describe('computeReportScopeDrift ..-prefixed filename containment (F311)', () => {
  it('tracks in-root files whose names start with .. instead of skipping them', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-drift-dotdot-'));
    try {
      fs.writeFileSync(path.join(tmp, '..foo.ts'), 'modified content');
      const drift = await computeReportScopeDrift(
        { scopeManifest: { files: [{ path: '..foo.ts', sha256: '0'.repeat(64) }] } } as never,
        tmp,
      );
      expect(drift?.modifiedPaths).toEqual(['..foo.ts']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
