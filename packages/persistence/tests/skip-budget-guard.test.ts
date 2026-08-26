/**
 * Skip-budget guard for `packages/persistence/tests/project-endpoint.test.ts`.
 *
 * This test pins the budget at 5 fingerprint entries recorded in
 * `architecture/test-skip-budget.json`. Each entry represents a distinct
 * conditional-skip / skip / suite-alias shape that the file relies on for
 * cross-platform coverage. The budget must NOT grow without a deliberate
 * review: adding a sixth skip is the kind of drift that turns "platform
 * coverage" into "always skipped on CI".
 *
 * A budget SHRINK is welcome and is the only sanctioned way to remove
 * fingerprints. The test tolerates fewer entries; it rejects more.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const BUDGET = path.resolve(REPO_ROOT, 'architecture/test-skip-budget.json');
const FILE_PATH = 'packages/persistence/tests/project-endpoint.test.ts';

interface BudgetFile {
  schemaVersion: number;
  declarations: Array<{ file: string; kind: string; fingerprint: string }>;
}

describe('project-endpoint.test.ts skip budget', () => {
  it('the file is referenced in architecture/test-skip-budget.json', async () => {
    const text = await fs.readFile(BUDGET, 'utf8');
    const budget = JSON.parse(text) as BudgetFile;
    const matches = budget.declarations.filter((d) => d.file === FILE_PATH);
    expect(matches.length, 'expected at least 1 budget entry for the file').toBeGreaterThan(0);
  });

  it('skip budget stays at or below 5 fingerprint entries', async () => {
    const text = await fs.readFile(BUDGET, 'utf8');
    const budget = JSON.parse(text) as BudgetFile;
    const matches = budget.declarations.filter((d) => d.file === FILE_PATH);
    expect(
      matches.length,
      `${FILE_PATH} has ${matches.length} skip fingerprints (ceiling: 5). ` +
        'Refactor the conditional suite-aliases into plain describe.skip or remove platform-specific cases entirely.',
    ).toBeLessThanOrEqual(5);
  });

  it('every fingerprint is unique within the file (no duplicate declarations)', async () => {
    const text = await fs.readFile(BUDGET, 'utf8');
    const budget = JSON.parse(text) as BudgetFile;
    const fingerprints = budget.declarations
      .filter((d) => d.file === FILE_PATH)
      .map((d) => d.fingerprint);
    const unique = new Set(fingerprints);
    expect(unique.size).toBe(fingerprints.length);
  });
});
