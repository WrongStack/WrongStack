/**
 * Tests for VerificationReportPanel — verifies rendering across all verdict
 * states, check results, file scope, sub-tasks, and attachments. Accounts for
 * the component's collapsible section defaults (Check Results opens when
 * verdict !== 'passed'; other sections start collapsed).
 *
 * The panel renders `activity:verifyReport.*` labels. Since the B-13 i18n
 * slim-down (2cda2161b) the `activity` namespace is no longer bundled inline —
 * it resolves through the async resourcesToBackend chunks, whose load timing is
 * non-deterministic under vitest/jsdom (same constraint as
 * tests/i18n/locale-switch.test.tsx). Register the English bundle synchronously
 * so translated-label assertions stay deterministic.
 */

import { render, screen } from '@testing-library/react';
import type {
  KanbanVerificationAttachment,
  KanbanVerificationCheckResult,
  KanbanVerificationFileScope,
  KanbanVerificationReport,
  KanbanVerificationSubtasks,
} from '@wrongstack/kanban';
import { beforeAll, expect, test } from 'vitest';
import { VerificationReportPanel } from '../../src/components/VerificationReportPanel';
import { i18n } from '../../src/i18n';
import activity_en from '../../src/i18n/locales/en/activity.json';

beforeAll(() => {
  i18n.addResourceBundle('en', 'activity', activity_en, true, true);
});

const BASE: Omit<KanbanVerificationReport, 'verdict'> = {
  taskId: 't1',
  taskTitle: 'Test',
  boardId: 'b1',
  startedAt: '2026-07-23T10:00:00Z',
  completedAt: '2026-07-23T10:05:00Z',
  checks: [],
  markdownSummary: '',
  attachments: [],
};

// ── Verdict ──────────────────────────────────────────────────────────────────

test('passed verdict', () => {
  render(
    <VerificationReportPanel report={{ ...BASE, verdict: 'passed', markdownSummary: 'OK.' }} />,
  );
  expect(screen.getByText('Passed')).toBeTruthy();
  expect(screen.getByText('OK.')).toBeTruthy();
});

test('failed verdict', () => {
  render(
    <VerificationReportPanel report={{ ...BASE, verdict: 'failed', markdownSummary: 'FAIL.' }} />,
  );
  expect(screen.getByText('Failed')).toBeTruthy();
  expect(screen.getByText('FAIL.')).toBeTruthy();
});

test('needs_human verdict', () => {
  render(
    <VerificationReportPanel
      report={{ ...BASE, verdict: 'needs_human', markdownSummary: 'Review.' }}
    />,
  );
  expect(screen.getByText('Needs Review')).toBeTruthy();
  expect(screen.getByText('Review.')).toBeTruthy();
});

test('incomplete verdict', () => {
  render(<VerificationReportPanel report={{ ...BASE, verdict: 'incomplete' }} />);
  expect(screen.getByText('Incomplete')).toBeTruthy();
});

// ── Check results ───────────────────────────────────────────────────────────

const CHECKS: KanbanVerificationCheckResult[] = [
  {
    checkId: 'c1',
    description: 'File exists: readme.md',
    type: 'file_exists',
    status: 'passed',
    evidence: {},
  },
  {
    checkId: 'c2',
    description: 'Tests pass',
    type: 'test',
    status: 'failed',
    evidence: {},
    error: '2 failed',
  },
  {
    checkId: 'c3',
    description: 'Exit code',
    type: 'command',
    status: 'error',
    evidence: {},
    error: 'blocked',
  },
];

test('check descriptions and statuses visible when section open', () => {
  // verdict != 'passed' → Check Results section starts OPEN
  render(<VerificationReportPanel report={{ ...BASE, verdict: 'failed', checks: CHECKS }} />);
  expect(screen.getByText('File exists: readme.md')).toBeTruthy();
  expect(screen.getByText('Tests pass')).toBeTruthy();
  expect(screen.getByText('Exit code')).toBeTruthy();
  expect(screen.getAllByText('Failed')).toHaveLength(2); // verdict badge + check row
  expect(screen.getByText('Passed')).toBeTruthy();
  expect(screen.getByText('Error')).toBeTruthy();
});

test('type badge rendered', () => {
  render(<VerificationReportPanel report={{ ...BASE, verdict: 'failed', checks: [CHECKS[0]!] }} />);
  expect(screen.getByText('file_exists', { exact: false })).toBeTruthy();
});

// ── File scope ───────────────────────────────────────────────────────────────

test('mismatch indicator shown', () => {
  const fs: KanbanVerificationFileScope = {
    expectedChanges: 2,
    actualChanges: 3,
    scopeMatches: false,
    files: [{ path: 'src/debug.log', operation: 'create', expected: false, linesChanged: 100 }],
  };
  render(<VerificationReportPanel report={{ ...BASE, verdict: 'failed', fileScope: fs }} />);
  expect(screen.getByText(/Scope mismatch/)).toBeTruthy();
  expect(screen.getByText('unexpected')).toBeTruthy();
});

test('section header shown when collapsed', () => {
  const fs: KanbanVerificationFileScope = {
    expectedChanges: 1,
    actualChanges: 1,
    scopeMatches: true,
    files: [{ path: 'src/lib.ts', operation: 'modify', expected: true, linesChanged: 5 }],
  };
  render(<VerificationReportPanel report={{ ...BASE, verdict: 'passed', fileScope: fs }} />);
  expect(screen.getByText('File Scope')).toBeTruthy();
});

// ── Sub-tasks ────────────────────────────────────────────────────────────────

test('sub-task section header shown', () => {
  const st: KanbanVerificationSubtasks = {
    total: 3,
    completed: 2,
    failed: 1,
    children: [{ taskId: 'c1', title: 'Write tests', verdict: 'passed' }],
  };
  render(<VerificationReportPanel report={{ ...BASE, verdict: 'failed', subtasks: st }} />);
  expect(screen.getByText('Sub-Tasks')).toBeTruthy();
});

// ── Attachments ──────────────────────────────────────────────────────────────

test('attachment count in section header', () => {
  const att: KanbanVerificationAttachment[] = [
    { kind: 'diff', label: 'Changes.diff', content: '+ new', path: 'changes.diff' },
  ];
  render(<VerificationReportPanel report={{ ...BASE, verdict: 'passed', attachments: att }} />);
  expect(screen.getByText('Attachments (1)')).toBeTruthy();
});

// ── Edge cases ───────────────────────────────────────────────────────────────

test('empty optional sections not rendered', () => {
  render(
    <VerificationReportPanel report={{ ...BASE, verdict: 'passed', markdownSummary: 'Minimal' }} />,
  );
  expect(screen.getByText('Minimal')).toBeTruthy();
  expect(screen.queryByText('Check Results')).toBeNull();
});

test('all sections present with complete data', () => {
  const st: KanbanVerificationSubtasks = { total: 1, completed: 0, failed: 0, children: [] };
  render(
    <VerificationReportPanel
      report={{
        ...BASE,
        verdict: 'needs_human',
        markdownSummary: 'Full.',
        checks: CHECKS,
        fileScope: { expectedChanges: 0, actualChanges: 0, scopeMatches: true, files: [] },
        subtasks: st,
        attachments: [{ kind: 'command_output', label: 'Log', content: 'x' }],
      }}
    />,
  );
  expect(screen.getByText('Check Results')).toBeTruthy();
  expect(screen.getByText('File Scope')).toBeTruthy();
  expect(screen.getByText('Sub-Tasks')).toBeTruthy();
  expect(screen.getByText('Attachments (1)')).toBeTruthy();
});

// ── Header duration formatting ───────────────────────────────────────────────
// formatDuration joins whole minutes with rounded seconds; a duration in the
// last 500 ms of a minute must carry into the next minute instead of
// rendering "1m 60s".

const durationReport = (ms: number): KanbanVerificationReport => {
  const startedAt = '2026-07-23T10:00:00.000Z';
  return {
    ...BASE,
    verdict: 'passed',
    markdownSummary: 'OK.',
    startedAt,
    completedAt: new Date(Date.parse(startedAt) + ms).toISOString(),
  };
};

test('carry band: 119.5s renders as 2m 0s, not 1m 60s', () => {
  render(<VerificationReportPanel report={durationReport(119_500)} />);
  expect(screen.getByText('2m 0s')).toBeTruthy();
});

test('just below the carry band: 119.499s renders as 1m 59s', () => {
  render(<VerificationReportPanel report={durationReport(119_499)} />);
  expect(screen.getByText('1m 59s')).toBeTruthy();
});

test('exact two minutes renders as 2m 0s', () => {
  render(<VerificationReportPanel report={durationReport(120_000)} />);
  expect(screen.getByText('2m 0s')).toBeTruthy();
});

test('ordinary minute-second mix renders as 1m 3s', () => {
  render(<VerificationReportPanel report={durationReport(63_000)} />);
  expect(screen.getByText('1m 3s')).toBeTruthy();
});

test('sub-second and one-second boundaries render as 999ms and 1s', () => {
  const { unmount } = render(<VerificationReportPanel report={durationReport(999)} />);
  expect(screen.getByText('999ms')).toBeTruthy();
  unmount();
  render(<VerificationReportPanel report={durationReport(1_000)} />);
  expect(screen.getByText('1s')).toBeTruthy();
});

test('end before start renders no duration text', () => {
  render(
    <VerificationReportPanel
      report={{
        ...BASE,
        verdict: 'passed',
        markdownSummary: 'OK.',
        startedAt: '2026-07-23T10:05:00.000Z',
        completedAt: '2026-07-23T10:00:00.000Z',
      }}
    />,
  );
  expect(screen.queryByText(/^\d/)).toBeNull();
});
