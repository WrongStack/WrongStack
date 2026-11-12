/**
 * Tests for Finding Store slash commands and integration.
 *
 * FS-P0.5 + FS-P0.6
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ChimeraReviewCompletePayload, resolveChimeraConfig } from '../src/chimera-plugin.js';
import { executeFindingCommand } from '../src/review-finding-commands.js';
import { JsonlFindingStore } from '../src/review-finding-store.js';
import type { ChimeraFinding } from '../src/review-finding-types.js';

let dir: string;
let store: JsonlFindingStore;

function makeFinding(overrides: Partial<ChimeraFinding> = {}): ChimeraFinding {
  const id = randomUUID();
  return {
    id,
    fingerprint: overrides.fingerprint ?? `fp-${id}`,
    severity: overrides.severity ?? 'high',
    source: overrides.source ?? 'auto',
    location: overrides.location ?? { file: 'src/test.ts', line: 1 },
    title: overrides.title ?? 'Test finding',
    description: overrides.description ?? 'A test finding description',
    status: overrides.status ?? 'active',
    originReport: overrides.originReport ?? {
      reportId: 'report-1',
      sessionId: 'sess-1',
      agentId: 'chimera-review',
      reviewerModel: 'gpt-5.6-sol',
    },
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    ...overrides,
  };
}

function makeReviewPayload(reviewText: string): ChimeraReviewCompletePayload {
  return {
    bundle: {
      config: resolveChimeraConfig({}, 'test-provider', 'test-model'),
      cwd: dir,
      files: [],
    },
    reviewText,
    status: 'success',
    cwd: dir,
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finding-cmd-'));
  store = new JsonlFindingStore(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// ── Slash commands ─────────────────────────────────────────────────

describe('/review findings slash commands', () => {
  it('returns help text for --help', async () => {
    const output = await executeFindingCommand(['--help'], { projectDir: dir });
    expect(output).toContain('/review findings');
    expect(output).toContain('--severity');
  });

  it('lists no findings for an empty store', async () => {
    const output = await executeFindingCommand(['findings'], { projectDir: dir });
    expect(output).toContain('No findings found');
  });

  it('lists findings after upsert', async () => {
    await store.upsert([makeFinding({ severity: 'critical', title: 'Critical bug one' })], {
      sessionId: 's',
      reportId: 'r',
      agentId: 'chimera-review',
      model: 'test-model',
    });
    const output = await executeFindingCommand(['findings'], { projectDir: dir });
    expect(output).toContain('critical');
    expect(output).toContain('Critical bug');
  });

  it('renders the basename for forward, backslash, and mixed-separator locations', async () => {
    // Regression: the File column computed the basename as a chained substring
    // whose second lastIndexOf('\\') was evaluated on the ORIGINAL string but
    // applied to the ALREADY-TRUNCATED result, so mixed-separator locations
    // (drive backslash + forward relative rest on win32) rendered garbage like
    // `e.ts` instead of `file.ts`. The all-backslash case passed by accident,
    // which is why only the mixed shape catches this.
    await store.upsert(
      [
        makeFinding({
          title: 'r2 forward',
          location: { file: 'packages/core/src/file.ts', line: 1 },
        }),
        makeFinding({
          title: 'r2 backslash',
          location: { file: 'packages\\core\\src\\file.ts', line: 1 },
        }),
        makeFinding({
          title: 'r2 mixed',
          location: { file: 'C:\\repo/packages/core/src/file.ts', line: 1 },
        }),
      ],
      { sessionId: 's', reportId: 'r', agentId: 'chimera-review', model: 'test-model' },
    );
    const output = await executeFindingCommand(['findings'], { projectDir: dir });
    for (const title of ['r2 forward', 'r2 backslash', 'r2 mixed']) {
      const row = output
        .split('\n')
        .find((line) => line.includes(title) && line.trim().startsWith('|'));
      expect(row, `findings row for '${title}'`).toBeTruthy();
      expect(row).toContain('`file.ts`');
    }
  });

  it('filters by severity', async () => {
    await store.upsert(
      [
        makeFinding({ severity: 'critical', title: 'Critical bug' }),
        makeFinding({ severity: 'low', title: 'Low issue' }),
      ],
      { sessionId: 's', reportId: 'r', agentId: 'chimera-review', model: 'test-model' },
    );
    const output = await executeFindingCommand(['findings', '--severity', 'critical'], {
      projectDir: dir,
    });
    expect(output).toContain('Critical bug');
    expect(output).not.toContain('Low issue');
  });

  it('shows a single finding by ID', async () => {
    const f = makeFinding({ title: 'Specific finding' });
    await store.upsert([f], {
      sessionId: 's',
      reportId: 'r',
      agentId: 'chimera-review',
      model: 'test-model',
    });
    const output = await executeFindingCommand(['finding', f.id], { projectDir: dir });
    expect(output).toContain('Specific finding');
    expect(output).toContain(f.location?.file ?? '');
  });

  it('shows lifecycle events for a finding', async () => {
    const f = makeFinding({ title: 'Triaged bug' });
    await store.upsert([f], {
      sessionId: 's',
      reportId: 'r',
      agentId: 'chimera-review',
      model: 'test-model',
    });
    await store.transition(f.id, 'triaged', { id: 'operator-1', kind: 'operator' });
    const output = await executeFindingCommand(['finding', f.id], { projectDir: dir });
    expect(output).toContain('Lifecycle');
    expect(output).toContain('triaged');
  });

  it('returns not-found for unknown ID', async () => {
    const output = await executeFindingCommand(['finding', 'nonexistent-id'], { projectDir: dir });
    expect(output).toContain('not found');
  });

  it('shows status summary', async () => {
    await store.upsert(
      [
        makeFinding({ severity: 'critical', title: 'A' }),
        makeFinding({ severity: 'high', title: 'B' }),
        makeFinding({ severity: 'low', title: 'C' }),
      ],
      { sessionId: 's', reportId: 'r', agentId: 'chimera-review', model: 'test-model' },
    );
    const output = await executeFindingCommand(['status'], { projectDir: dir });
    expect(output).toContain('3');
    expect(output).toContain('critical');
    expect(output).toContain('low');
  });

  it('returns unknown subcommand message', async () => {
    const output = await executeFindingCommand(['badcmd'], { projectDir: dir });
    expect(output).toContain('Unknown subcommand');
  });

  it('shows finding ID for reference', async () => {
    const f = makeFinding({ title: 'Pinned bug' });
    await store.upsert([f], {
      sessionId: 's',
      reportId: 'r',
      agentId: 'chimera-review',
      model: 'test-model',
    });
    const output = await executeFindingCommand(['finding', f.id], { projectDir: dir });
    expect(output).toContain(f.id);
  });

  it('supports --flag=value syntax, ignores negative --limit, and resolves unambiguous short finding IDs', async () => {
    const f = makeFinding({
      id: 'abcdef12-3456-4789-abcd-ef1234567890',
      severity: 'critical',
      title: 'Short ID finding',
    });
    await store.upsert([f], {
      sessionId: 's',
      reportId: 'r',
      agentId: 'chimera-review',
      model: 'test-model',
    });

    const listOut = await executeFindingCommand(['findings', '--severity=critical', '--limit=-5'], {
      projectDir: dir,
    });
    expect(listOut).toContain('Short ID finding');

    const showOut = await executeFindingCommand(['finding', 'abcdef12'], { projectDir: dir });
    expect(showOut).toContain('Short ID finding');

    const triageOut = await executeFindingCommand(
      ['finding', 'abcdef12', 'triage', '--reason=acknowledged'],
      { projectDir: dir },
    );
    expect(triageOut).toContain('triaged');
    expect((await store.get(f.id))?.status).toBe('triaged');
  });

  it('surfaces token/cache telemetry, session intent, and deleted-file references in /review status, reports, and report detail', async () => {
    const { JsonlReportStore } = await import('../src/review-report-store.js');
    const reportStore = new JsonlReportStore(dir);
    await reportStore.persist({
      id: 'rep-12345678-aaaa',
      sessionId: 'sess-telemetry',
      agentId: 'chimera-review',
      reviewerModel: 'claude-sonnet-4-6',
      source: 'chimera',
      reviewStatus: 'success',
      files: [{ path: 'src/caller.ts', status: 'modified' }],
      counts: { critical: 0, high: 1, medium: 0, low: 0 },
      totalFindings: 1,
      unparseableCount: 0,
      rawText: '## 🦂 Chimera Review',
      usage: {
        inputTokens: 800,
        outputTokens: 150,
        cacheReadTokens: 2400,
        totalTokens: 950,
        costUsd: 0.0042,
        iterations: 1,
        toolCalls: 0,
      },
      scopeManifest: {
        headSha: 'deadbeef',
        isIncremental: true,
        files: [{ path: 'src/caller.ts', status: 'modified', isIncrementalDelta: true }],
        deletedFiles: ['src/obsoleteHelper.ts'],
        deletedFileReferences: [
          { deletedPath: 'src/obsoleteHelper.ts', referencedBy: ['src/caller.ts'] },
        ],
        signatureCallers: [
          {
            symbol: 'bootEngine',
            file: 'src/engine.ts',
            callers: ['src/cli.ts:18'],
          },
        ],
        sessionIntent: ['Drop obsoleteHelper intentionally after migrating callers'],
      },
    });

    const listOut = await executeFindingCommand(['reports'], { projectDir: dir });
    expect(listOut).toContain('Tokens');
    expect(listOut).toContain('950 ($0.0042)');

    const detailOut = await executeFindingCommand(['report', 'rep-12345678'], { projectDir: dir });
    expect(detailOut).toContain('**Session intent:**');
    expect(detailOut).toContain('Drop obsoleteHelper intentionally after migrating callers');
    expect(detailOut).toContain('**Deleted-file references:**');
    expect(detailOut).toContain('`src/obsoleteHelper.ts` → `src/caller.ts`');
    expect(detailOut).toContain('**Modified export callers:**');
    expect(detailOut).toContain('`bootEngine` (`src/engine.ts`) → `src/cli.ts:18`');

    const statusOut = await executeFindingCommand(['status'], { projectDir: dir });
    expect(statusOut).toContain('### Review Reports & Token Telemetry');
    expect(statusOut).toContain('1 incremental delta');
    expect(statusOut).toContain('[75%]');
    expect(statusOut).toContain('$0.0042');
  });
});

// ── Integration ────────────────────────────────────────────────────

describe('integrateFindings', () => {
  it('returns empty result for empty report', async () => {
    const { integrateFindings } = await import('../src/review-finding-integration.js');
    const result = await integrateFindings(makeReviewPayload(''), dir, 'report-1');
    expect(result.created).toBe(0);
    expect(result.totalFindings).toBe(0);
  });

  it('persists findings from a parsed report', async () => {
    const { integrateFindings } = await import('../src/review-finding-integration.js');
    const report = [
      '### Critical (1)',
      '1. [BUG] src/app.ts:42 — Null dereference',
      '',
      '### High (2)',
      '1. src/db.ts:15 — Unclosed connection',
      '2. src/auth.ts:3 — Hardcoded token',
    ].join('\n');

    const result = await integrateFindings(makeReviewPayload(report), dir, 'report-2');
    expect(result.created).toBe(3);
    expect(result.totalFindings).toBe(3);
    expect(result.unparseableCount).toBe(0);
    expect(result.reportId).toBeTruthy();

    const persisted = await store.list();
    expect(persisted).toHaveLength(3);
    expect(persisted.every((finding) => finding.source === 'chimera')).toBe(true);
    expect(persisted.every((finding) => finding.originReport.reportId === result.reportId)).toBe(
      true,
    );
    expect(persisted.every((finding) => finding.originReport.reviewerModel === 'test-model')).toBe(
      true,
    );
  });
});
