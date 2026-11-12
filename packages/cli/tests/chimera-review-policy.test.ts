import { describe, expect, it } from 'vitest';
import {
  buildChimeraReviewTaskDescription,
  isChimeraAllClearReview,
} from '../src/chimera-review-task.js';
import {
  applyChimeraReviewerReadOnlyPolicy,
  CHIMERA_REVIEW_READ_ONLY_TOOLS,
} from '../src/execution.js';

describe('Chimera reviewer tool policy', () => {
  it('exposes only read-only inspection tools', () => {
    const config = applyChimeraReviewerReadOnlyPolicy({
      name: 'chimera-review',
      tools: ['edit', 'write', 'patch', 'exec'],
      allowedCapabilities: ['fs.write', 'shell.exec'],
    });

    expect(config.tools).toEqual([...CHIMERA_REVIEW_READ_ONLY_TOOLS]);
    expect(config.allowedCapabilities).toEqual(['fs.read']);
    expect(config.worktree).toBe('off');
    expect(config.tools).not.toEqual(
      expect.arrayContaining([
        'edit',
        'write',
        'patch',
        'update',
        'replace',
        'format',
        'bash',
        'exec',
        'git',
      ]),
    );
  });
});

describe('Chimera all-clear classification', () => {
  it('recognizes canonical clean review reports', () => {
    expect(
      isChimeraAllClearReview(
        '## 🦂 Chimera Review — all clear ✅\nNo issues found in 2 changed files.',
      ),
    ).toBe(true);
  });

  it('recognizes legacy clean review wording', () => {
    expect(isChimeraAllClearReview('🦂 Chimera review: all clear — no issues found.')).toBe(true);
  });

  it('does not classify reports with findings as all-clear', () => {
    expect(
      isChimeraAllClearReview('## 🦂 Chimera Review\n\n### High (1)\n1. [BUG] src/a.ts:1 — broken'),
    ).toBe(false);
  });

  it('does not classify mixed finding reports as all-clear just because they say no issues found', () => {
    expect(
      isChimeraAllClearReview(
        '## 🦂 Chimera Review\n\n### High (1)\n1. [BUG] src/a.ts:1 — broken\n\nNo issues found in other files.',
      ),
    ).toBe(false);
  });
});

describe('buildChimeraReviewTaskDescription context enrichment & JSON-only contract', () => {
  it('renders HEAD, incremental delta markers, symbols, paired tests, prior findings, and JSON-only output instruction', () => {
    const task = buildChimeraReviewTaskDescription({
      cwd: '/repo',
      headSha: 'abc12345',
      cascadeDepth: 1,
      deletedFiles: ['src/removed.ts'],
      deletedFileReferences: [{ deletedPath: 'src/removed.ts', referencedBy: ['src/auth.ts'] }],
      signatureCallers: [
        {
          symbol: 'login',
          file: 'src/auth.ts',
          callers: ['src/routes/login.ts:24'],
        },
      ],
      sessionIntent: ['Keep guest fallback intentional while tightening auth token checks'],
      config: {
        enabled: true,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        maxFiles: 15,
        autoFix: 'off',
        cascadeOn: 'high',
        maxCascadeDepth: 2,
        fallbackModels: [],
        fallbackProfile: undefined,
      },
      files: [
        {
          path: 'src/auth.ts',
          status: 'modified',
          content: 'export function login() {}\n',
          diff: '@@ -1,1 +1,1 @@\n   1 | +export function login() {}',
          addedLines: 1,
          removedLines: 1,
          isIncrementalDelta: true,
          unchangedHunkSummary: 'Full session diff vs HEAD: +5/-2 across 2 hunk(s).',
          changedSymbols: ['login'],
          pairedTestPath: 'tests/auth.test.ts',
          pairedTestUpdated: false,
        },
      ],
      priorFindings: [
        {
          id: 'f-1',
          severity: 'medium',
          status: 'ignored',
          file: 'src/auth.ts',
          line: 1,
          title: 'Intentional guest fallback',
        },
        {
          id: 'f-2',
          severity: 'high',
          status: 'active',
          file: 'src/auth.ts',
          line: 10,
          title: 'Missing token check',
        },
      ],
    });

    expect(task).toContain('HEAD: abc12345');
    expect(task).toContain('[INCREMENTAL DELTA]');
    expect(task).toContain('Changed symbols: login');
    expect(task).toContain('Paired test: tests/auth.test.ts (NOT updated');
    expect(task).toContain('Deleted files in working tree');
    expect(task).toContain('src/removed.ts — ⚠ STILL REFERENCED IN: src/auth.ts');
    expect(task).toContain('External callers of modified exported symbols');
    expect(task).toContain(
      '`login` (modified in `src/auth.ts`) → referenced at: src/routes/login.ts:24',
    );
    expect(task).toContain('Session intent');
    expect(task).toContain('Keep guest fallback intentional while tightening auth token checks');
    expect(task).toContain('DO NOT RE-REPORT');
    expect(task).toContain('VERIFY IF FIXED BY CASCADE');
    expect(task).toContain('Respond with ONLY the raw JSON object `{"findings": [...]}`');
  });
});
