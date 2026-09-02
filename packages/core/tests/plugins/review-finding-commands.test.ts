/**
 * Tests for Finding Store slash commands and integration.
 *
 * FS-P0.5 + FS-P0.6
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeFindingCommand } from '../../src/plugins/review-finding-commands.js';
import {
  resolveChimeraConfig,
  type ChimeraReviewCompletePayload,
} from '../../src/plugins/chimera-plugin.js';
import { JsonlFindingStore } from '../../src/plugins/review-finding-store.js';
import type { ChimeraFinding } from '../../src/plugins/review-finding-types.js';

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
});

// ── Integration ────────────────────────────────────────────────────

describe('integrateFindings', () => {
  it('returns empty result for empty report', async () => {
    const { integrateFindings } = await import('../../src/plugins/review-finding-integration.js');
    const result = await integrateFindings(makeReviewPayload(''), dir, 'report-1');
    expect(result.created).toBe(0);
    expect(result.totalFindings).toBe(0);
  });

  it('persists findings from a parsed report', async () => {
    const { integrateFindings } = await import('../../src/plugins/review-finding-integration.js');
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
