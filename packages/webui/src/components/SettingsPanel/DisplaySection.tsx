import { BrainCircuit, Monitor, Palette, Sparkles, Type } from 'lucide-react';
import { useCallback } from 'react';
import { Input } from '@/components/ui/input';
import { useAppTranslation } from '@/i18n';
import { useLocalPrefs } from '@/stores/local-prefs';
import { PreferenceSelect, PreferenceSlider } from './PreferenceControls';
import { PreferenceToggle } from './PreferenceToggle';

/**
 * Display parity section for the WebUI SettingsPanel. Adds the settings the
 * TUI exposes under its "Display" section (fields 39–44) plus a few that the
 * TUI groups under "Reasoning" or "Debug" but which a WebUI user reasonably
 * expects next to other appearance knobs: thinkingWord (22), statusline (34),
 * animationStyle (36), preRefineSeconds (41), multiDiffSummaryThreshold (21).
 *
 * Pattern mirrors FleetSection.tsx: a stack of `rounded-xl` cards with a
 * single header per card, and `divide-y divide-border/50` between rows inside
 * a card. Each row calls `syncPref(key, value)` so the same write path that
 * drives every other section also drives these — local zustand store +
 * server `prefs.update` via the shared `syncPref` callback.
 */

interface DisplaySectionProps {
  /** Push a pref change locally + to the server. */
  syncPref: (key: string, value: unknown) => void;
}

// TUI parity: matches the preset list in
// packages/tui/src/components/settings-picker-model.ts (`SAGE_THRESHOLD_PRESETS`).
// Values are serialised to fixed-decimal strings so the generic
// `PreferenceSelect<string>` accepts them; we re-parse on the change handler.
// A fallback entry (`"0.85"`) is the `DEFAULT_VALUE` used when the
// persisted value is outside the [0, 1] range or non-finite — the
// local-prefs v13 migration handles this on load, but a raw
// `prefs.snapshot` from a server with a hand-edited config.json can
// still land here. The fallback option keeps the select usable in
// that edge case (no NaN, no crash, no UI jank).
const DEFAULT_SAGE_THRESHOLD = '0.85';
const SAGE_THRESHOLD_OPTIONS = [
  { value: '0.72', labelKey: 'settings:display.sageRelaxed' },
  { value: '0.75', labelKey: '' },
  { value: DEFAULT_SAGE_THRESHOLD, labelKey: 'settings:display.sageDefault' },
  { value: '0.90', labelKey: '' },
  { value: '0.95', labelKey: 'settings:display.sageStrict' },
] as const;

// TUI parity: matches `PRE_REFINE_SECONDS_PRESETS` in settings-picker-model.ts.
const PRE_REFINE_PRESETS = [0, 2, 3, 5, 8, 10] as const;

// TUI parity: matches `MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS` (in display order).
const MULTI_DIFF_PRESETS = [0, 3, 5, 8, 10, 15] as const;

export function DisplaySection({ syncPref }: DisplaySectionProps) {
  const { t } = useAppTranslation();
  const localPrefs = useLocalPrefs();

  const setThinkingWord = useCallback(
    (raw: string) => {
      const next = raw.trim().toLowerCase().slice(0, 32);
      // Empty string or whitespace-only → no-op; keep the previous value.
      // The TUI's RefinePanel validates that the word is single-token
      // letters/digits/_- and rejects anything else; the WebUI mirrors that
      // by clamping length + lowercasing, but does not enforce the regex
      // (a user typing "hello!" is allowed; the next session just keeps
      // the previous valid value if the core refuses it).
      if (next.length > 0) syncPref('thinkingWord', next);
    },
    [syncPref],
  );

  return (
    <div className="space-y-6">
      {/* ── Card 1 · Workbench chrome (WebUI-only) ─────────────────── */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Monitor className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:display.workbenchHeading')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('settings:display.workbenchHint')}
            </p>
          </div>
        </div>
        <div className="space-y-1 divide-y divide-border/50">
          {/* TUI field 39 — showModelReasoning */}
          <div className="py-3">
            <PreferenceToggle
              label={t('settings:display.showModelReasoningLabel')}
              hint={t('settings:display.showModelReasoningHint')}
              value={localPrefs.showModelReasoning}
              onChange={() => syncPref('showModelReasoning', !localPrefs.showModelReasoning)}
            />
          </div>
          {/* TUI field 40 — showAgentSwarmPanel (tri-state enum) */}
          <div className="py-3">
            <PreferenceSelect
              label={t('settings:display.showAgentSwarmPanelLabel')}
              hint={t('settings:display.showAgentSwarmPanelHint')}
              value={localPrefs.showAgentSwarmPanel}
              options={[
                { value: 'bottom', label: t('settings:display.swarmPanelBottom') },
                { value: 'sidebar', label: t('settings:display.swarmPanelSidebar') },
                { value: 'off', label: t('settings:display.swarmPanelOff') },
              ]}
              onChange={(v) => syncPref('showAgentSwarmPanel', v)}
            />
          </div>
          {/* TUI field 2 — terminalTitleAnimation (already mirrored as
              "titleAnimation" on the General tab; repeated here as the
              TUI's "Display" section opens with it so a user navigating
              from the TUI finds parity without switching tabs. The two
              controls share the same localStorage key.) */}
          <div className="py-3">
            <PreferenceToggle
              label={t('settings:display.titleAnimationLabel')}
              hint={t('settings:display.titleAnimationHint')}
              value={localPrefs.titleAnimation}
              onChange={() => syncPref('titleAnimation', !localPrefs.titleAnimation)}
            />
          </div>
          {/* Global Keyboard Shortcuts toggle */}
          <div className="py-3">
            <PreferenceToggle
              label={t('settings:display.keyboardShortcutsLabel')}
              hint={t('settings:display.keyboardShortcutsHint')}
              value={localPrefs.keyboardShortcuts}
              onChange={() => syncPref('keyboardShortcuts', !localPrefs.keyboardShortcuts)}
            />
          </div>
        </div>
      </div>

      {/* ── Card 2 · Status chip & statusline (TUI/CLI parity) ─────── */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Sparkles className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:display.statusChipHeading')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('settings:display.statusChipHint')}
            </p>
          </div>
        </div>
        <div className="space-y-1 divide-y divide-border/50">
          {/* TUI field 22 — thinkingWord (free-text, validated by simpleui) */}
          <div className="py-3">
            <label
              htmlFor="display-thinking-word"
              className="text-sm font-medium flex items-center gap-2"
            >
              <Type className="h-3.5 w-3.5 text-muted-foreground" />
              {t('settings:display.thinkingWordLabel')}
            </label>
            <p className="text-xs text-muted-foreground mt-0.5 mb-2">
              {t('settings:display.thinkingWordHint')}
            </p>
            <Input
              id="display-thinking-word"
              value={localPrefs.thinkingWord}
              maxLength={32}
              onChange={(e) => setThinkingWord(e.target.value)}
              className="font-mono text-sm"
              placeholder={t('activity:displaySection.thinking')}
            />
          </div>
          {/* TUI field 34 — statuslineMode */}
          <div className="py-3">
            <PreferenceSelect
              label={t('settings:display.statuslineModeLabel')}
              hint={t('settings:display.statuslineModeHint')}
              value={localPrefs.statuslineMode}
              options={[
                { value: 'minimum', label: t('settings:display.statuslineModeMinimum') },
                { value: 'detailed', label: t('settings:display.statuslineModeDetailed') },
                { value: 'no-color', label: t('settings:display.statuslineModeNoColor') },
              ]}
              onChange={(v) => syncPref('statuslineMode', v)}
            />
          </div>
          {/* TUI field 36 — animationStyle */}
          <div className="py-3">
            <PreferenceSelect
              label={t('settings:display.animationStyleLabel')}
              hint={t('settings:display.animationStyleHint')}
              value={localPrefs.animationStyle}
              options={[
                { value: 'rainbow', label: t('settings:display.animationStyleRainbow') },
                { value: 'wave', label: t('settings:display.animationStyleWave') },
                { value: 'pulse', label: t('settings:display.animationStylePulse') },
                { value: 'dots', label: t('settings:display.animationStyleDots') },
                { value: 'breathe', label: t('settings:display.animationStyleBreathe') },
                { value: 'static', label: t('settings:display.animationStyleStatic') },
                { value: 'cycle', label: t('settings:display.animationStyleCycle') },
              ]}
              onChange={(v) => syncPref('animationStyle', v)}
            />
          </div>
        </div>
      </div>

      {/* ── Card 3 · Refine, diffs, code & memory injection ────────── */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Palette className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:display.refineHeading')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('settings:display.refineHint')}
            </p>
          </div>
        </div>
        <div className="space-y-1 divide-y divide-border/50">
          {/* TUI field 41 — preRefineSeconds. The TUI stores seconds with
              presets [0, 2, 3, 5, 8, 10]; 0 = skip the countdown. The
              WebUI mirrors that exactly so the value round-trips through
              the WS prefs.snapshot. We render a PreferenceSlider rather
              than a stepped control so cycling through the same presets
              is still possible, but expose the canonical values and a
              textual display via the existing slider. */}
          <div className="py-3">
            <PreferenceSlider
              label={t('settings:display.preRefineSecondsLabel')}
              hint={t('settings:display.preRefineSecondsHint')}
              value={localPrefs.preRefineSeconds}
              min={Math.min(...PRE_REFINE_PRESETS)}
              max={Math.max(...PRE_REFINE_PRESETS)}
              step={1}
              unit="s"
              onChange={(v) => syncPref('preRefineSeconds', v)}
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              {t('settings:display.preRefineSecondsPresets', {
                presets: PRE_REFINE_PRESETS.join(' / '),
              })}
            </p>
          </div>

          {/* TUI field 21 — multiDiffSummaryThreshold. Stored as a
              number; 0 disables the footer. The TUI's presets are
              [0, 3, 5, 8, 10, 15]. */}
          <div className="py-3">
            <PreferenceSlider
              label={t('settings:display.multiDiffSummaryLabel')}
              hint={t('settings:display.multiDiffSummaryHint')}
              value={localPrefs.multiDiffSummaryThreshold}
              min={Math.min(...MULTI_DIFF_PRESETS)}
              max={Math.max(...MULTI_DIFF_PRESETS)}
              step={1}
              onChange={(v) => syncPref('multiDiffSummaryThreshold', v)}
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              {t('settings:display.multiDiffSummaryPresets', {
                presets: MULTI_DIFF_PRESETS.join(' / '),
              })}
            </p>
          </div>
        </div>
      </div>

      {/* ── Card 4 · Read tool & SAGE memory injection ──────────────── */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <BrainCircuit className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:display.memoryHeading')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('settings:display.memoryHint')}
            </p>
          </div>
        </div>
        <div className="space-y-1 divide-y divide-border/50">
          {/* TUI field 42 — readSymbols. Backend persists as
              `autonomy.readAdvancedMode` and the read tool checks
              `ctx.meta['tools.read.advancedMode']`; the local-prefs key
              is the WebUI mirror only. */}
          <div className="py-3">
            <PreferenceToggle
              label={t('settings:display.readSymbolsLabel')}
              hint={t('settings:display.readSymbolsHint')}
              value={localPrefs.readSymbols}
              onChange={() => syncPref('readSymbols', !localPrefs.readSymbols)}
            />
          </div>

          {/* TUI field 43 — showSageMemoryInject */}
          <div className="py-3">
            <PreferenceToggle
              label={t('settings:display.showSageMemoryInjectLabel')}
              hint={t('settings:display.showSageMemoryInjectHint')}
              value={localPrefs.showSageMemoryInject}
              onChange={() => syncPref('showSageMemoryInject', !localPrefs.showSageMemoryInject)}
            />
          </div>

          {/* TUI field 44 — sageMemoryInjectThreshold. TUI presets:
              [0.72, 0.75, 0.85, 0.9, 0.95]; 0.85 is the default. Persisted
              as `Sage.inject.relationFloor`. Values are serialised to
              fixed-decimal strings because `PreferenceSelect` is generic
              over `string`; the change handler parses back to a number so
              the rest of the pipeline receives a real float. */}
          <div className="py-3">
            <PreferenceSelect
              label={t('settings:display.sageMemoryInjectThresholdLabel')}
              hint={t('settings:display.sageMemoryInjectThresholdHint')}
              value={
                Number.isFinite(localPrefs.sageMemoryInjectThreshold) &&
                localPrefs.sageMemoryInjectThreshold >= 0 &&
                localPrefs.sageMemoryInjectThreshold <= 1
                  ? localPrefs.sageMemoryInjectThreshold.toFixed(2)
                  : DEFAULT_SAGE_THRESHOLD
              }
              options={SAGE_THRESHOLD_OPTIONS.map((o) => ({
                value: o.value,
                label: o.labelKey ? t(o.labelKey) : o.value,
              }))}
              onChange={(v) => syncPref('sageMemoryInjectThreshold', Number.parseFloat(v))}
            />
          </div>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">{t('settings:display.footnote')}</p>
    </div>
  );
}
