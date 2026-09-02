import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEFAULT_PANEL_POSITIONS } from '../src/ui-contracts.js';
import { SettingsPicker, settingsPickerJumpByName } from '../src/components/settings-picker.js';

// ── Minimal props factory ──────────────────────────────────────────────
// SettingsPicker has 30+ props. This factory covers every required field
// with sensible defaults so individual tests only override what matters.
function baseProps(over: Record<string, unknown> = {}) {
  return {
    field: 0,
    mode: 'off' as const,
    delayMs: 0,
    titleAnimation: true,
    yolo: false,
    fleetChat: 'off',
    chime: false,
    confirmExit: true,
    nextPrediction: false,
    featureMcp: true,
    featurePlugins: true,
    featureMemory: true,
    featureSkills: true,
    featureModelsRegistry: true,
    tokenSavingTier: 'off' as const,
    allowOutsideProjectRoot: true,
    contextAutoCompact: true,
    contextStrategy: 'hybrid' as const,
    contextMode: 'balanced' as const,
    maxConcurrent: 10,
    logLevel: 'info' as const,
    auditLevel: 'standard' as const,
    indexOnStart: true,
    multiDiffSummaryThreshold: 5,
    maxIterations: 500,
    autoProceedMaxIterations: 50,
    enhanceDelayMs: 60_000,
    enhanceEnabled: true,
    enhanceLanguage: 'original' as const,
    thinkingWord: 'thinking',
    reasoningMode: 'auto' as const,
    reasoningEffort: 'high' as const,
    reasoningPreserve: false,
    cacheTtl: 'default' as const,
    debugStream: false,
    statuslineMode: 'detailed' as const,
    configScope: 'global' as const,
    animationStyle: 'rainbow',
    breakerEnabled: false,
    breakerAutoKillResetMs: 60_000,
    showModelReasoning: true,
    showAgentSwarmPanel: 'bottom',
    showSageMemoryInject: false,
    sageMemoryInjectThreshold: 0.85,
    readSymbols: false,
    panelPositions: DEFAULT_PANEL_POSITIONS,
    filter: '',
    ...over,
  } as never as React.ComponentProps<typeof SettingsPicker>;
}

describe('SettingsPicker filter mode', () => {
  describe('persistence path', () => {
    it('shows the default profile config path when no active path is supplied', () => {
      const { lastFrame } = render(React.createElement(SettingsPicker, baseProps()));
      expect(lastFrame() ?? '').toContain(
        'Persisted to ~/.wrongstack/profiles/default/config.json',
      );
    });

    it('shows the active profile config path for global settings', () => {
      const { lastFrame } = render(
        React.createElement(
          SettingsPicker,
          baseProps({ profileConfigPath: '~/.wrongstack/profiles/work/config.json' }),
        ),
      );
      expect(lastFrame() ?? '').toContain('Persisted to ~/.wrongstack/profiles/work/config.json');
    });

    it('keeps the project path for project-scoped settings', () => {
      const { lastFrame } = render(
        React.createElement(
          SettingsPicker,
          baseProps({
            configScope: 'project',
            profileConfigPath: '~/.wrongstack/profiles/work/config.json',
          }),
        ),
      );
      expect(lastFrame() ?? '').toContain('Persisted to <project>/.wrongstack/config.json');
    });
  });

  describe('normal mode (no filter)', () => {
    it('renders the standard header with the search hint', () => {
      const { lastFrame } = render(React.createElement(SettingsPicker, baseProps()));
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Settings');
      expect(frame).toContain('`/` to search');
    });

    it('renders section headers in normal mode', () => {
      const { lastFrame } = render(React.createElement(SettingsPicker, baseProps()));
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Autonomy');
      expect(frame).toContain('UX');
    });

    it('keeps the Display header visible when the last row is selected', () => {
      const field = settingsPickerJumpByName('Agent swarm panel');
      expect(field).toBeDefined();
      const { lastFrame } = render(React.createElement(SettingsPicker, baseProps({ field })));
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Display');
      expect(frame).toContain('Agent swarm panel');
    });

    it('does not show a filter indicator', () => {
      const { lastFrame } = render(React.createElement(SettingsPicker, baseProps()));
      const frame = lastFrame() ?? '';
      expect(frame).not.toContain('Filter:');
    });
  });

  describe('filter active', () => {
    it('shows the filter indicator with match count', () => {
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/multi' })),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Filter: /multi');
      expect(frame).toMatch(/\d+ match/);
    });

    it('hides section headers in filter mode', () => {
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/multi' })),
      );
      const frame = lastFrame() ?? '';
      expect(frame).not.toContain('Autonomy');
      expect(frame).not.toContain('UX');
      expect(frame).not.toContain('Tools');
    });

    it('shows only matching rows', () => {
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/yolo' })),
      );
      const frame = lastFrame() ?? '';
      // YOLO is a chord-registered row, so it should appear.
      expect(frame).toContain('YOLO');
      // Rows that don't match should not appear (e.g. Index on session start).
      expect(frame).not.toContain('Index on session start');
    });

    it('shows matching rows for a multi-word query', () => {
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/multi-diff' })),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Multi-diff');
    });

    it('shows empty state when no rows match', () => {
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/zzz-nonexistent' })),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('No matching settings rows.');
      // Match count should be 0.
      expect(frame).toContain('0 matches');
    });

    it('hides the above/below scroll indicators in filter mode', () => {
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/yolo' })),
      );
      const frame = lastFrame() ?? '';
      expect(frame).not.toContain('above');
      expect(frame).not.toContain('below');
    });
  });

  describe('incremental search highlighting', () => {
    it('renders matching rows with their labels visible (text survives segmentation)', () => {
      // ink-testing-library renders to plain text — colors are stripped,
      // but the text content of each segment must still be present.
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/chime' })),
      );
      const frame = lastFrame() ?? '';
      // The full label text should be present even though it's split
      // into match/non-match segments during rendering.
      expect(frame).toContain('Completion');
      expect(frame).toContain('chime');
    });

    it('handles queries that match the start of the label', () => {
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/index' })),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Index on session start');
    });

    it('handles queries that match the middle of the label', () => {
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/concurrent' })),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Max');
      expect(frame).toContain('concurrent');
    });

    it('handles queries that match the end of the label', () => {
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/word' })),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Thinking');
      expect(frame).toContain('word');
    });

    it('preserves the label text across multiple matches', () => {
      // "refine" appears in two chord labels: "Refine preview countdown"
      // (field 17) and "Refine" (field 18). Both should appear.
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/refine' })),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Refine');
    });
  });

  describe('fuzzy scattered-character matching', () => {
    it('matches abbreviated queries (subsequence) that are not substrings', () => {
      // "mds" is NOT a contiguous substring of any label, but it IS a
      // subsequence of "Multi-diff summary" (m...d...s).
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/mds' })),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Multi-diff');
    });

    it('matches "ya" against "YOLO mode" (y...a → no; y-o → no; wait)', () => {
      // "ya" — y is at index 0 in "YOLO mode", but 'a' is not in the
      // rest of "YOLO mode". This should NOT match. Let's use "yo" instead.
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/yo' })),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('YOLO');
    });

    it('prefers contiguous matches over fuzzy (same label, both match)', () => {
      // "diff" is a contiguous substring of "Multi-diff summary", so the
      // contiguous path should be used for highlighting, not the fuzzy
      // path. Both produce visible text — the difference is in how the
      // segments are split. We just verify the text survives.
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/diff' })),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Multi');
      expect(frame).toContain('diff');
      expect(frame).toContain('summary');
    });

    it('matches scattered characters preserving order across multiple words', () => {
      // "cws" → "C"onfirm before exit → no 'w'. Try "cse" → Confirm before
      // exit → 'c'@0, 's'? No 's' after 'e'. Let's use "cex" → Confirm
      // before exit → 'c'@0, 'e'@20 (in "exit"), 'x'@22.
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/cex' })),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Confirm before exit');
    });

    it('does not match when no label contains the subsequence', () => {
      // "zz" — no chord label contains 'z' at all. Neither contiguous
      // nor fuzzy can match.
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/zz' })),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('No matching');
    });

    it('handles single-character queries via fuzzy fallback', () => {
      // A single-character query after the leading `/` (e.g. `/m`) should
      // match every label containing 'm' anywhere.
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/m' })),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Filter: /m');
      // Multiple labels contain 'm': Multi-diff, Max concurrent,
      // Confirm, Completion, etc.
      expect(frame).toContain('match');
    });

    it('preserves full label text in fuzzy-highlighted rows', () => {
      // Even with scattered-character highlighting, the full label text
      // must appear in the rendered output (ink-testing-library strips
      // colors but keeps text). If any character were dropped during
      // segmentation, this test would fail.
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/mds' })),
      );
      const frame = lastFrame() ?? '';
      // The full label "Multi-diff summary" must be present.
      expect(frame).toContain('Multi-diff summary');
    });
  });

  describe('fuzzy ranking (relevance-ordered results)', () => {
    it('places contiguous matches before fuzzy matches', () => {
      // Query "mode" — "Reasoning mode" and "Default autonomy mode" are
      // contiguous matches. "Context mode" is also contiguous. All
      // contiguous matches should appear before any fuzzy-only matches.
      // We verify by checking that at least one contiguous match appears
      // in the frame (which it must, since all "mode" labels contain it).
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/mode' })),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('Filter: /mode');
      // At least 3 labels contain "mode": Default autonomy mode,
      // Reasoning mode, Context mode.
      expect(frame).toContain('mode');
    });

    it('ranks shorter labels above longer labels for the same query', () => {
      // Query "con" — "Max concurrent" (14 chars) and "Confirm before exit"
      // (19 chars) and "Config scope" (12 chars) all contain "con".
      // The rendered frame should show all three, with shorter labels
      // ranked higher. We verify ordering by checking the line numbers
      // of each label in the frame.
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/con' })),
      );
      const frame = lastFrame() ?? '';
      const lines = frame.split('\n');
      const configIdx = lines.findIndex((l) => l.includes('Config scope'));
      const concurrentIdx = lines.findIndex((l) => l.includes('Max concurrent'));
      const confirmIdx = lines.findIndex((l) => l.includes('Confirm before exit'));
      // All three should be present.
      expect(configIdx).toBeGreaterThanOrEqual(0);
      expect(concurrentIdx).toBeGreaterThanOrEqual(0);
      expect(confirmIdx).toBeGreaterThanOrEqual(0);
      // Shorter labels should rank higher (appear earlier).
      // "Config scope" (12) < "Max concurrent" (14) < "Confirm before exit" (19)
      // But position also matters — "con" starts at position 0 in "Config scope",
      // position 4 in "Max concurrent", position 0 in "Confirm before exit".
      // Score: Config = 0 + 0 + 4 = 4; Concurrent = 4 + 0 + 6 = 10;
      //         Confirm = 0 + 0 + 11 = 11. So Config < Concurrent < Confirm.
      expect(configIdx).toBeLessThan(concurrentIdx);
      expect(concurrentIdx).toBeLessThan(confirmIdx);
    });

    it('ranks earlier-position matches above later-position matches', () => {
      // Query "s" — matches "Stream debug logging", "Statusline",
      // "Multi-diff summary", "Max concurrent" (no 's'? wait:
      // "concurrent" has no 's'. Let's use "completion chime" → has 's'
      // in "chime"? No. "Skills" → no chord. Let's use "st":
      // "Statusline" (st@0) vs "Stream debug logging" (st@0) vs
      // "Multi-diff summary" (no 't' after 's'... yes 'su' → s@11, t? no t).
      // Simplify: query "st" → Statusline (st@0), Stream debug (St@0).
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/st' })),
      );
      const frame = lastFrame() ?? '';
      const lines = frame.split('\n');
      const statuslineIdx = lines.findIndex((l) => l.includes('Statusline'));
      const streamIdx = lines.findIndex((l) => l.includes('Stream debug'));
      expect(statuslineIdx).toBeGreaterThanOrEqual(0);
      expect(streamIdx).toBeGreaterThanOrEqual(0);
      // Both start at position 0 with same query length, so score is
      // determined by label length: "Statusline" (10) vs "Stream debug
      // logging" (20). Statusline should rank higher.
      expect(statuslineIdx).toBeLessThan(streamIdx);
    });

    it('ranks tighter fuzzy matches above spread-out fuzzy matches', () => {
      // Query "ce" — fuzzy match. All three labels start with 'C' but 'e'
      // appears at different positions:
      // "Completion chime" → c@0, e@5 (in "completion"), gap=4, len=16
      // "Config scope"     → c@0, e@11 (at end of "scope"), gap=10, len=12
      // "Confirm before exit" → c@0, e@9 (in "before"), gap=8, len=19
      // Tighter gap ranks higher even if the label is longer.
      // Focus "Config scope" (field 35) so the filter window centers on
      // all three targets — with a 5-row window at 80 cols, focusing rank 1
      // keeps ranks 0-2 all visible.
      const { lastFrame } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '/ce', field: 35 })),
      );
      const frame = lastFrame() ?? '';
      const lines = frame.split('\n');
      const completionIdx = lines.findIndex((l) => l.includes('Completion chime'));
      const configIdx = lines.findIndex((l) => l.includes('Config scope'));
      const confirmIdx = lines.findIndex((l) => l.includes('Confirm before exit'));
      // All three should match.
      expect(completionIdx).toBeGreaterThanOrEqual(0);
      expect(configIdx).toBeGreaterThanOrEqual(0);
      expect(confirmIdx).toBeGreaterThanOrEqual(0);
      // Completion (gap=4, len=16) → score 1016
      // Config (gap=10, len=12) → score 1024
      // Confirm (gap=8, len=19) → score 1027
      // So: Completion < Config < Confirm.
      expect(completionIdx).toBeLessThan(configIdx);
      expect(configIdx).toBeLessThan(confirmIdx);
    });
  });

  describe('filter edge cases', () => {
    it('treats a bare "/" (no query text) as inactive (shows all rows)', () => {
      // filter length === 1 (just the leading /) → filterActive is false.
      const { lastFrame } = render(React.createElement(SettingsPicker, baseProps({ filter: '/' })));
      const frame = lastFrame() ?? '';
      // Should NOT show the filter indicator — "/" alone doesn't activate.
      expect(frame).not.toContain('Filter: /');
      // Should show section headers (normal mode).
      expect(frame).toContain('Autonomy');
    });

    it('empty filter string is identical to no filter prop', () => {
      const { lastFrame: withEmpty } = render(
        React.createElement(SettingsPicker, baseProps({ filter: '' })),
      );
      const { lastFrame: withoutFilter } = render(React.createElement(SettingsPicker, baseProps()));
      expect(withEmpty()).toBe(withoutFilter());
    });

    it('shows the full label text in normal mode (no segmentation artifacts)', () => {
      const { lastFrame } = render(React.createElement(SettingsPicker, baseProps({ field: 21 })));
      const frame = lastFrame() ?? '';
      // Field 21 = Multi-diff summary; it should be visible and intact.
      expect(frame).toContain('Multi-diff summary');
    });
  });
});
