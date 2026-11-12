// @vitest-environment jsdom
/**
 * Class-level net for the leaked-mouse-as-input bug.
 *
 * With mouse tracking on, Ink strips the leading ESC and hands the rest of every
 * SGR report to EVERY mounted `useInput` handler as plain TEXT (`[<0;12;4M`).
 * A surface that treats any non-empty input as a keystroke therefore reacts to
 * a stray click: the pre-refine countdown resolved as "send as-is", and the
 * kanban/clear editors typed the report into the buffer. Three layers guard the
 * class now:
 *
 *   1. `sweep` — mounts real surfaces, writes raw reports, and asserts no
 *      decision fired and the frame is unchanged, then presses a real key to
 *      prove the handler was live (so the assertion cannot pass on a dead one).
 *   2. roster — every component whose `useInput` handler consumes `input` must
 *      be swept here or listed in {@link UNSWEPT} with a reason. A new panel
 *      with an input handler fails this test until someone classifies it.
 *   3. shape — a file that appends raw input to a buffer must drop leaked
 *      reports (or gate on a single printable char). This is the rule the
 *      kanban editor broke.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { BrainDecisionPrompt } from '../src/components/brain-decision-prompt.js';
import { BugHuntContinuePanel } from '../src/components/bug-hunt-continue-panel.js';
import { CheckpointTimeline } from '../src/components/checkpoint-timeline.js';
import { ConfirmPrompt } from '../src/components/confirm-prompt.js';
import { ConnectionsPanel } from '../src/components/connections-panel.js';
import { ContextPanel } from '../src/components/context-panel.js';
import { ContinueConfirmPanel } from '../src/components/continue-confirm-panel.js';
import { CoordinatorPanel } from '../src/components/coordinator-panel.js';
import { CronJobsMonitor } from '../src/components/cron-jobs.js';
import { EnhancePanel } from '../src/components/enhance-panel.js';
import { EscConfirmPrompt } from '../src/components/esc-confirm-prompt.js';
import { GoalPanel } from '../src/components/goal-panel.js';
import { InspectOverlay } from '../src/components/inspect-overlay.js';
import { RefineCountdownPanel } from '../src/components/refine-countdown-panel.js';
import { SendModePicker } from '../src/components/send-mode-picker.js';
import { ShellCommandWarning } from '../src/components/shell-command-warning.js';
import { WorktreeMonitor } from '../src/components/worktree-monitor.js';
import {
  contextPanelData,
  coordinatorFixture,
  cronSnapshot,
  goalFixture,
  renderMonitorPanel,
  worktreeTimelineEvents,
} from './helpers/monitor-panel-fixtures.js';

// Monitor panels read their data through service modules rather than props, and
// Vitest hoists `vi.mock` per test module, so these live here (the fixtures they
// serve are in tests/helpers/monitor-panel-fixtures.tsx). Inert for every other
// case in this file: no other swept surface imports these modules.
vi.mock('../src/connections-health.js', () => ({
  collectConnectionsHealth: async () =>
    (await import('./helpers/monitor-panel-fixtures.js')).connectionsReport(),
}));
vi.mock('../src/connection-actions.js', () => ({
  executeConnectionAction: async () => null,
  isRestartableService: () => true,
}));

const COMPONENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components');

/** Raw report plus the ESC-stripped form Ink actually delivers. */
const LEAKS = ['\x1b[<0;12;4M', '[<0;12;4M', '[<65;20;6M'];

interface Mounted {
  view: ReturnType<typeof render>;
  spies: ReturnType<typeof vi.fn>[];
}

interface SweepCase {
  file: string;
  /** Every callback that must stay silent through a pointer report. */
  mount: () => Mounted;
  /** A real key that MUST move this surface — proves the handler is live. */
  /** One key, or a sequence of chunks written in order (e.g. 'x' then 'y'). */
  liveKey: string | string[];
  /**
   * False for surfaces whose own 1s countdown re-renders the frame while the
   * leak is being written: a byte-identical frame assertion would be flaky
   * there. Those cases still assert no callback fired and no leak rendered.
   */
  stableFrame?: boolean;
  /**
   * Liveness assertion for a surface whose action has no observable callback
   * (plan-panel's scope switch). Receives the frame from just before the key.
   */
  assertLive?: (view: ReturnType<typeof render>, before: string) => void;
}

const CASES: SweepCase[] = [
  {
    file: 'refine-countdown-panel.tsx',
    mount: () => {
      const onDecision = vi.fn();
      return {
        view: render(
          <RefineCountdownPanel
            original="fix the login bug"
            seconds={30}
            onDecision={onDecision}
          />,
        ),
        spies: [onDecision],
      };
    },
    liveKey: 'x',
  },
  {
    file: 'send-mode-picker.tsx',
    mount: () => {
      const onMove = vi.fn();
      const onSelect = vi.fn();
      return {
        view: render(<SendModePicker selected={0} onMove={onMove} onSelect={onSelect} />),
        spies: [onMove, onSelect],
      };
    },
    liveKey: 'q',
  },
  {
    file: 'esc-confirm-prompt.tsx',
    mount: () => {
      const onConfirm = vi.fn();
      const onCancel = vi.fn();
      return {
        view: render(
          <EscConfirmPrompt
            runningTools={['bash']}
            subagentCount={0}
            onConfirm={onConfirm}
            onCancel={onCancel}
          />,
        ),
        spies: [onConfirm, onCancel],
      };
    },
    liveKey: 'y',
  },
  {
    file: 'brain-decision-prompt.tsx',
    mount: () => {
      const onAnswer = vi.fn();
      return {
        view: render(
          <BrainDecisionPrompt
            requestId="req-1"
            source="brain"
            risk="high"
            question="Deploy to production?"
            options={[
              { id: 'opt-deploy', label: 'Deploy now' },
              { id: 'opt-hold', label: 'Hold' },
            ]}
            onAnswer={onAnswer}
          />,
        ),
        spies: [onAnswer],
      };
    },
    liveKey: 'd', // Esc/D is the documented safe denial
  },
  {
    file: 'confirm-prompt.tsx',
    mount: () => {
      const onDecision = vi.fn();
      const onEnableYolo = vi.fn();
      return {
        view: render(
          <ConfirmPrompt
            toolName="exec"
            input={{ command: 'rm -rf build' }}
            suggestedPattern="exec"
            onDecision={onDecision}
            onEnableYolo={onEnableYolo}
          />,
        ),
        spies: [onDecision, onEnableYolo],
      };
    },
    liveKey: 'y',
  },
  {
    file: 'shell-command-warning.tsx',
    mount: () => {
      const onDecision = vi.fn();
      return {
        view: render(<ShellCommandWarning command="rm -rf build" onDecision={onDecision} />),
        spies: [onDecision],
      };
    },
    liveKey: 'y',
  },
  {
    file: 'bug-hunt-continue-panel.tsx',
    mount: () => {
      const onDecision = vi.fn();
      return {
        view: render(
          <BugHuntContinuePanel completedRounds={2} totalRounds={3} onDecision={onDecision} />,
        ),
        spies: [onDecision],
      };
    },
    liveKey: 'y',
    stableFrame: false, // its own 1s round countdown re-renders the frame
  },
  {
    file: 'continue-confirm-panel.tsx',
    mount: () => {
      const onDecision = vi.fn();
      return {
        view: render(
          <ContinueConfirmPanel
            label="Continue → fix the parser"
            instruction="fix the parser"
            source="open" // no countdown for an unanchored guess
            grounded={false}
            delayMs={0}
            onDecision={onDecision}
          />,
        ),
        spies: [onDecision],
      };
    },
    liveKey: 'e',
  },
  {
    file: 'checkpoint-timeline.tsx',
    mount: () => {
      const onSelect = vi.fn();
      const onConfirm = vi.fn();
      const onFork = vi.fn();
      const onClose = vi.fn();
      return {
        view: render(
          <CheckpointTimeline
            checkpoints={[
              {
                promptIndex: 0,
                promptPreview: 'fix the parser',
                ts: '2026-09-28T10:00:00.000Z',
                fileCount: 2,
              },
              {
                promptIndex: 1,
                promptPreview: 'add tests',
                ts: '2026-09-28T10:05:00.000Z',
                fileCount: 4,
              },
            ]}
            selected={0}
            onSelect={onSelect}
            onConfirm={onConfirm}
            onFork={onFork}
            onClose={onClose}
          />,
        ),
        spies: [onSelect, onConfirm, onFork, onClose],
      };
    },
    liveKey: 'f',
  },
  {
    file: 'enhance-panel.tsx',
    mount: () => {
      const onDecision = vi.fn();
      return {
        view: render(
          <EnhancePanel
            original="fix the parser"
            refined="Fix the parser bug"
            english="Fix the parser bug"
            delayMs={30_000}
            onDecision={onDecision}
          />,
        ),
        spies: [onDecision],
      };
    },
    liveKey: 'e',
  },
  {
    file: 'inspect-overlay.tsx',
    mount: () => {
      const onScroll = vi.fn();
      const onClose = vi.fn();
      return {
        view: render(
          <InspectOverlay
            title="bash"
            body={'line one\nline two'}
            scroll={0}
            termCols={100}
            viewportRows={40}
            onScroll={onScroll}
            onClose={onClose}
          />,
        ),
        spies: [onScroll, onClose],
      };
    },
    liveKey: 'q',
  },
  {
    file: 'coordinator-panel.tsx',
    mount: () => {
      const onClose = vi.fn();
      return {
        view: renderMonitorPanel(
          <CoordinatorPanel coordinator={coordinatorFixture()} nowTick={0} onClose={onClose} />,
        ),
        spies: [onClose],
      };
    },
    liveKey: 'q', // coordinator-panel.tsx:77 — needs usePanelShortcutsEnabled
  },
  {
    file: 'connections-panel.tsx',
    mount: () => {
      const onClose = vi.fn();
      return {
        view: renderMonitorPanel(<ConnectionsPanel projectRoot="/tmp/project" onClose={onClose} />),
        spies: [onClose],
      };
    },
    liveKey: 'q', // connections-panel.tsx:259 — gated on shortcuts being enabled
    stableFrame: false, // its 8s refresh re-fetches and re-renders
  },
  {
    file: 'context-panel.tsx',
    mount: () => {
      const onClose = vi.fn();
      return {
        view: renderMonitorPanel(<ContextPanel data={contextPanelData()} onClose={onClose} />),
        spies: [onClose],
      };
    },
    liveKey: 'q', // context-panel.tsx:90
  },
  {
    file: 'goal-panel.tsx',
    mount: () => {
      const onCoordinatorStart = vi.fn();
      return {
        view: renderMonitorPanel(
          <GoalPanel goal={goalFixture()} onCoordinatorStart={onCoordinatorStart} />,
        ),
        spies: [onCoordinatorStart],
      };
    },
    liveKey: 'c', // goal-panel.tsx:50 — start the coordinator for the visible goal
  },
  {
    file: 'worktree-monitor.tsx',
    mount: () => {
      const onClose = vi.fn();
      return {
        view: renderMonitorPanel(
          <WorktreeMonitor
            events={worktreeTimelineEvents()}
            nowTick={Date.now()}
            onClose={onClose}
          />,
        ),
        spies: [onClose],
      };
    },
    liveKey: '\x17', // Ctrl+W — worktree-monitor.tsx:44; 'q' does NOT close it
  },
  {
    file: 'cron-jobs.tsx',
    mount: () => {
      const onCancel = vi.fn(async () => null);
      return {
        view: renderMonitorPanel(
          <CronJobsMonitor getCronJobs={async () => cronSnapshot()} onCancel={onCancel} />,
        ),
        spies: [onCancel],
      };
    },
    liveKey: ['x', 'y'], // cron-jobs.tsx:190 arms the cancel, 174 confirms it
    stableFrame: false, // the job list arrives asynchronously
  },
];

interface UnsweptEntry {
  reason: string;
  /**
   * Machine-checked citation, for entries whose safety rests on a guard inside
   * the file rather than on a mounted sweep. The roster test reads this exact
   * line, so a moved or deleted guard fails the sweep instead of silently
   * aging a reason nobody re-reads.
   */
  guard?: { line: number; contains: string };
}

/**
 * Input-consuming surfaces that are NOT mounted here, each with the reason. The
 * roster test below fails on any file that is in neither this map nor `CASES`.
 */
const UNSWEPT: Record<string, UnsweptEntry> = {
  'input.tsx': {
    reason: 'drops the leak itself before forwarding a keystroke to handleKey',
    guard: { line: 241, contains: 'isLeakedMouseInput' },
  },
  'user-input-prompt.tsx': {
    reason: 'drops the leak itself; also owns a raw-stdin mouse parser',
    guard: { line: 184, contains: 'isLeakedMouseInput' },
  },
  'refine-failure-panel.tsx': {
    reason: 'single-printable-char gate: an SGR report is 9 chars and can never be typed',
    guard: { line: 124, contains: 'input.length === 1' },
  },
  'kanban-panel.tsx': {
    reason:
      'prompt-editor leak guarded in-file and pinned in tests/kanban-panel-mount.test.tsx; mounting here needs kanban IPC mocks',
  },
  'plan-panel.tsx': {
    reason:
      "closes only via F5/Esc, which the central esc-close-panels table owns; its one in-panel key ('s') triggers an async scope switch with no callback, so it needs the assertLive frame-change control plus a node:fs/promises mock for its plan file",
  },
  'session-tree-overlay.tsx': {
    reason: 'drops the leak itself before the branch-name editor appends a keystroke',
    guard: { line: 150, contains: 'isLeakedMouseInput' },
  },
  'plugin-prompt-modal.tsx': {
    reason: 'drops the leak itself before the text-input kind appends a keystroke',
    guard: { line: 27, contains: 'isLeakedMouseInput' },
  },
  'plugin-panel-overlay.tsx': {
    reason:
      "matches only exact keys ('r', 'q') and single-char action shortcuts (input.length === 1); a 9-char SGR report matches none",
  },
  'image-preview-modal.tsx': {
    reason: "closes only on Esc or an exact 'q'; an SGR report is never 'q'",
  },
  'process-list.tsx': {
    reason:
      "no decision callback at all (it kills processes); its liveness control needs a registry killAll spy, but ProcessRegistry.stats()'s return shape is unverified, so the fake registry cannot be written blind",
  },
};

/** Handlers that consume the keystroke text rather than only key flags. */
const CONSUMES_INPUT = /use(?:Input|PanelInput)\(\s*\(input/;
/** A branch that appends the keystroke text itself to a buffer. */
const APPENDS_RAW_INPUT = /\$\{input\}|\.push\(input\)|\+\s*input\b/;
/** The alternative gate: only a single printable character may be typed. */
const SINGLE_CHAR_GATE = /input\.length === 1/;

function componentSources(): { file: string; source: string }[] {
  return readdirSync(COMPONENTS_DIR, { recursive: true })
    .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.tsx'))
    .map((entry) => ({
      file: entry.replace(/\\/g, '/').split('/').pop()!,
      source: stripComments(readFileSync(join(COMPONENTS_DIR, entry), 'utf8')),
    }));
}

/**
 * Comments are not code. The first run of this sweep flagged `resume-picker.tsx`
 * on the prose "status bar + input bar chrome" — a layout comment, not an
 * append. Both the shape rule and the guard-presence check below read
 * comment-stripped source, so a comment can neither trigger the rule nor claim
 * a guard the file does not have.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The raw, un-stripped line at a 1-based number — for citation checks. */
function rawLine(file: string, line: number): string {
  return readFileSync(join(COMPONENTS_DIR, file), 'utf8').split(/\r?\n/)[line - 1] ?? '';
}

describe.each(CASES)(
  '$file vs. raw pointer bytes',
  ({ mount, liveKey, stableFrame, assertLive }) => {
    it('ignores every leaked report, then still reacts to a real key', async () => {
      const { view, spies } = mount();
      try {
        // Let mount effects (terminal measure, size hooks, first data paint) land
        // before the first baseline, so a later render cannot be mistaken for a
        // reaction to the pointer report.
        await new Promise((resolve) => setImmediate(resolve));
        for (const leak of LEAKS) {
          const before = view.lastFrame();
          view.stdin.write(leak);
          await new Promise((resolve) => setImmediate(resolve));
          for (const spy of spies) expect(spy).not.toHaveBeenCalled();
          expect(view.lastFrame() ?? '').not.toContain('[<0');
          if (stableFrame !== false) expect(view.lastFrame() ?? '').toBe(before ?? '');
        }

        // Liveness control: without this, "no callback fired" could just mean the
        // mounted handler never worked at all.
        const beforeLive = view.lastFrame() ?? '';
        for (const chunk of typeof liveKey === 'string' ? [liveKey] : liveKey) {
          view.stdin.write(chunk);
          await new Promise((resolve) => setImmediate(resolve));
        }
        if (assertLive) assertLive(view, beforeLive);
        else expect(spies.some((spy) => spy.mock.calls.length > 0)).toBe(true);
      } finally {
        view.unmount();
      }
    });
  },
);

describe('leaked-mouse guard roster', () => {
  it('classifies every component whose useInput handler consumes input', () => {
    const swept = new Set(CASES.map((entry) => entry.file));
    const consuming = componentSources().filter((entry) => CONSUMES_INPUT.test(entry.source));

    expect(consuming.length).toBeGreaterThan(0);
    const unclassified = consuming
      .map((entry) => entry.file)
      .filter((file) => !swept.has(file) && !(file in UNSWEPT));

    expect(
      unclassified,
      'add these to the sweep (or to UNSWEPT with a reason) if they consume input:',
    ).toEqual([]);
  });

  it('keeps UNSWEPT free of stale entries', () => {
    const swept = new Set(CASES.map((entry) => entry.file));
    const consuming = new Set(
      componentSources()
        .filter((entry) => CONSUMES_INPUT.test(entry.source))
        .map((entry) => entry.file),
    );

    expect(
      Object.keys(UNSWEPT).filter((file) => !consuming.has(file) || swept.has(file)),
      'these entries no longer describe an un-swept input-consuming file:',
    ).toEqual([]);
  });

  it('verifies every cited guard still lives at the cited line', () => {
    const cited = Object.entries(UNSWEPT).flatMap(([file, entry]) =>
      entry.guard ? [{ file, ...entry.guard }] : [],
    );

    // The three surfaces that are safe because of an in-file guard rather than
    // a mounted sweep. A moved or deleted guard must fail HERE, not age quietly
    // into a reason nobody re-reads.
    expect(cited.length).toBeGreaterThanOrEqual(3);
    for (const { file, line, contains } of cited) {
      expect(
        rawLine(file, line),
        `${file}:${line} no longer contains "${contains}" — re-cite the guard or mount the surface in CASES`,
      ).toContain(contains);
    }
  });

  it('drops leaked reports in every file that appends raw input to a buffer', () => {
    for (const { file, source } of componentSources()) {
      if (!APPENDS_RAW_INPUT.test(source)) continue;
      const guarded = source.includes('isLeakedMouseInput') || SINGLE_CHAR_GATE.test(source);
      expect(guarded, `${file} appends raw input without dropping leaked mouse reports`).toBe(true);
    }
  });
});
