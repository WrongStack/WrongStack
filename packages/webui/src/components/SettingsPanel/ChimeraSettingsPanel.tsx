/**
 * Dedicated Chimera + Auto-review settings panel.
 *
 * Exposes every configurable option of both review plugins:
 * - `wstack-chimera`   → ResolvedChimeraConfig   (packages/core/src/plugins/chimera-plugin.ts:34)
 * - `wstack-auto-review` → ResolvedAutoReviewConfig (packages/core/src/plugins/auto-review-plugin.ts:42)
 *
 * Reads/writes the typed slots on `LocalPrefs` and propagates changes through
 * `syncPref` so the value is mirrored both locally (Zustand-persisted) and on
 * the server (via `prefs.update`, which persists to `config.extensions[…]` so
 * the running plugins pick up the change after a session restart).
 *
 * Provider/model/fallbackProfile selection reuses the existing unified
 * `ModelSelectDialog` (provider-model + fallback-profile tabs) so the
 * affordance matches the rest of the settings panel.
 */
import { Bug, ListPlus, Zap } from 'lucide-react';
import { useCallback, useState } from 'react';
import { ModelSelectDialog } from '@/components/ModelSelectDialog';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useLocalPrefs } from '@/stores/local-prefs';
import { PreferenceSelect, PreferenceSlider } from './PreferenceControls';
import { PreferenceToggle } from './PreferenceToggle';

interface ChimeraSettingsPanelProps {
  /** Push a pref change locally + to the server (see SettingsPanel.syncPref). */
  syncPref: (key: string, value: unknown) => void;
  /** Active session provider/model — surfaced as the "session default" hint. */
  sessionProvider?: string | undefined;
  sessionModel?: string | undefined;
}

export function ChimeraSettingsPanel({
  syncPref,
  sessionProvider,
  sessionModel,
}: ChimeraSettingsPanelProps) {
  const { t } = useAppTranslation();
  const localPrefs = useLocalPrefs();

  // Which ModelSelectDialog is open. The dialog can target either the
  // post-session chimera review (provider/model only) or the mid-session
  // auto-review (provider/model + fallback profile, since auto-review can
  // resolve from a profile).
  const [chimeraPickerOpen, setChimeraPickerOpen] = useState(false);
  const [autoReviewPickerOpen, setAutoReviewPickerOpen] = useState(false);

  const fallbackProfiles = localPrefs.fallbackProfiles ?? {};

  // Resolve the displayed fallback chain for the auto-review section.
  // If a fallback profile is selected, the chain comes from that profile;
  // otherwise we surface the session-effective chain (fallbackModels +
  // autoReviewFallbackModels) so the user can see what auto-review will use.
  const displayedChain: string[] = (() => {
    if (localPrefs.autoReviewFallbackProfile) {
      return fallbackProfiles[localPrefs.autoReviewFallbackProfile] ?? [];
    }
    return localPrefs.autoReviewFallbackModels ?? [];
  })();

  const openChimeraPicker = useCallback(() => setChimeraPickerOpen(true), []);
  const closeChimeraPicker = useCallback(() => setChimeraPickerOpen(false), []);
  const openAutoReviewPicker = useCallback(() => setAutoReviewPickerOpen(true), []);
  const closeAutoReviewPicker = useCallback(() => setAutoReviewPickerOpen(false), []);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
          <Bug className="h-4 w-4 text-muted-foreground" />
          {t('settings:features.chimeraDedicatedHeading')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t('settings:features.chimeraDedicatedHint')}
        </p>
      </div>

      {/* ─── Chimera (post-session) ────────────────────────────────────── */}
      <section
        className={cn(
          'space-y-3 rounded-lg border p-4',
          localPrefs.chimeraEnabled
            ? 'border-border/70 bg-card/40'
            : 'border-dashed border-border/50 bg-muted/30',
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-semibold">
              {t('settings:features.chimeraSectionEnabled')}
            </h4>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('settings:features.chimeraSectionEnabledHint')}
            </p>
          </div>
          <PreferenceToggle
            label={t('settings:features.chimeraSectionEnabled')}
            hint={t('settings:features.chimeraSectionEnabledHint')}
            value={localPrefs.chimeraEnabled}
            onChange={() => syncPref('chimeraEnabled', !localPrefs.chimeraEnabled)}
          />
        </div>

        <div className="pt-2 border-t">
          <PreferenceSelect
            label={t('settings:features.chimeraProviderLabel')}
            hint={t('settings:features.chimeraProviderHint')}
            value={localPrefs.chimeraProvider}
            options={[
              {
                value: '',
                label: sessionProvider
                  ? `${t('settings:features.chimeraProviderSessionDefault')} (${sessionProvider})`
                  : t('settings:features.chimeraProviderSessionDefault'),
              },
              // The dialog lets the user pick from keyed providers; show the
              // current value as a synthetic entry when it isn't the session default.
              ...(localPrefs.chimeraProvider && localPrefs.chimeraProvider !== sessionProvider
                ? [{ value: localPrefs.chimeraProvider, label: localPrefs.chimeraProvider }]
                : []),
            ]}
            onChange={(v) => syncPref('chimeraProvider', v)}
          />
        </div>

        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 rounded-lg border border-border p-3 text-left cursor-pointer hover:bg-muted/50 transition-colors"
          onClick={openChimeraPicker}
        >
          <div className="min-w-0 flex-1">
            <div className="text-xs text-muted-foreground">
              {t('settings:features.chimeraModelLabel')}
            </div>
            <div className="text-xs font-medium mt-0.5">
              {localPrefs.chimeraProvider || sessionProvider ? (
                <span className="font-mono">
                  {localPrefs.chimeraProvider || sessionProvider}/
                  {localPrefs.chimeraModel ||
                    sessionModel ||
                    t('settings:features.chimeraModelSessionDefault')}
                </span>
              ) : (
                <span className="text-muted-foreground">
                  {t('settings:features.chimeraModelSessionDefault')}
                </span>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {t('settings:features.chimeraModelHint')}
            </p>
          </div>
          <Zap className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>

        <PreferenceSlider
          label={t('settings:features.chimeraMaxFilesLabel')}
          hint={t('settings:features.chimeraMaxFilesHint')}
          value={localPrefs.chimeraMaxFiles}
          min={1}
          max={50}
          step={1}
          onChange={(v) => syncPref('chimeraMaxFiles', v)}
        />
      </section>

      {/* ─── Auto-review (mid-session) ───────────────────────────────── */}
      <section
        className={cn(
          'space-y-3 rounded-lg border p-4',
          localPrefs.autoReviewEnabled
            ? 'border-border/70 bg-card/40'
            : 'border-dashed border-border/50 bg-muted/30',
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-semibold">
              {t('settings:features.autoReviewSectionEnabled')}
            </h4>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('settings:features.autoReviewSectionEnabledHint')}
            </p>
          </div>
          <PreferenceToggle
            label={t('settings:features.autoReviewSectionEnabled')}
            hint={t('settings:features.autoReviewSectionEnabledHint')}
            value={localPrefs.autoReviewEnabled}
            onChange={() => syncPref('autoReviewEnabled', !localPrefs.autoReviewEnabled)}
          />
        </div>

        <div className="pt-2 border-t">
          <PreferenceSelect
            label={t('settings:features.autoReviewFallbackProfileLabel')}
            hint={t('settings:features.autoReviewFallbackProfileHint')}
            value={localPrefs.autoReviewFallbackProfile}
            options={[
              { value: '', label: t('settings:features.autoReviewFallbackProfileNone') },
              ...Object.keys(fallbackProfiles)
                .sort((a, b) => a.localeCompare(b))
                .map((name) => ({
                  value: name,
                  label: `${name} (${(fallbackProfiles[name] ?? []).length})`,
                })),
            ]}
            onChange={(v) => syncPref('autoReviewFallbackProfile', v)}
          />
        </div>

        <PreferenceSelect
          label={t('settings:features.autoReviewModelSelectionLabel')}
          hint={t('settings:features.autoReviewModelSelectionHint')}
          value={localPrefs.autoReviewModelSelection}
          options={[
            {
              value: 'round-robin',
              label: t('settings:features.autoReviewModelSelectionRoundRobin'),
            },
            { value: 'random', label: t('settings:features.autoReviewModelSelectionRandom') },
          ]}
          onChange={(v) => syncPref('autoReviewModelSelection', v)}
        />

        {/* Display the resolved chain (read-only). User edits the chain by
            editing the named profile or the global fallback chain. */}
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">
            {t('settings:features.autoReviewFallbackModelsLabel')}
          </div>
          <div className="flex flex-wrap gap-1 rounded-md border border-border bg-muted/30 px-2 py-1.5 min-h-[2rem]">
            {displayedChain.length === 0 ? (
              <span className="text-xs text-muted-foreground italic">
                {t('settings:features.autoReviewFallbackModelsEmpty')}
              </span>
            ) : (
              displayedChain.map((ref, i) => (
                <span
                  key={`${ref}-${i}`}
                  className="text-xs font-mono px-1.5 py-0.5 rounded bg-primary/10 text-primary"
                >
                  {ref}
                </span>
              ))
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">
            {t('settings:features.autoReviewFallbackModelsHint')}
          </p>
        </div>

        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 rounded-lg border border-border p-3 text-left cursor-pointer hover:bg-muted/50 transition-colors"
          onClick={openAutoReviewPicker}
        >
          <div className="min-w-0 flex-1">
            <div className="text-xs text-muted-foreground">
              {t('settings:features.autoReviewModelLabel')}
            </div>
            <div className="text-xs font-medium mt-0.5">
              {localPrefs.autoReviewProvider || sessionProvider ? (
                <span className="font-mono">
                  {localPrefs.autoReviewProvider || sessionProvider}/
                  {localPrefs.autoReviewModel ||
                    sessionModel ||
                    t('settings:features.chimeraModelSessionDefault')}
                </span>
              ) : (
                <span className="text-muted-foreground">
                  {t('settings:features.chimeraModelSessionDefault')}
                </span>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {t('settings:features.autoReviewModelHint')}
            </p>
          </div>
          <Zap className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>

        <div className="pt-2 border-t">
          <PreferenceSlider
            label={t('settings:features.autoReviewDebounceLabel')}
            hint={t('settings:features.autoReviewDebounceHint')}
            value={localPrefs.autoReviewDebounceMs}
            min={0}
            max={60_000}
            step={500}
            unit="ms"
            onChange={(v) => syncPref('autoReviewDebounceMs', v)}
          />
        </div>

        <PreferenceSlider
          label={t('settings:features.autoReviewMaxFilesLabel')}
          hint={t('settings:features.autoReviewMaxFilesHint')}
          value={localPrefs.autoReviewMaxFilesPerBatch}
          min={1}
          max={50}
          step={1}
          onChange={(v) => syncPref('autoReviewMaxFilesPerBatch', v)}
        />

        <PreferenceSlider
          label={t('settings:features.autoReviewMaxConcurrentLabel')}
          hint={t('settings:features.autoReviewMaxConcurrentHint')}
          value={localPrefs.autoReviewMaxConcurrentReviews}
          min={1}
          max={10}
          step={1}
          onChange={(v) => syncPref('autoReviewMaxConcurrentReviews', v)}
        />
      </section>

      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        <ListPlus className="h-3 w-3" />
        {t('settings:features.pluginsPerPluginHint')}
      </p>

      {/* ─── Picker dialogs ─────────────────────────────────────────── */}
      {chimeraPickerOpen && (
        <ModelSelectDialog
          open={chimeraPickerOpen}
          mode="provider-model"
          title={t('settings:features.chimeraPickModel')}
          hint={t('settings:features.chimeraPickModelHint')}
          onPick={(result) => {
            if (result.type === 'provider-model') {
              syncPref('chimeraProvider', result.provider);
              syncPref('chimeraModel', result.model);
            } else if (result.type === 'clear') {
              syncPref('chimeraProvider', '');
              syncPref('chimeraModel', '');
            }
            setChimeraPickerOpen(false);
          }}
          onClose={closeChimeraPicker}
        />
      )}
      {autoReviewPickerOpen && (
        <ModelSelectDialog
          open={autoReviewPickerOpen}
          mode="both"
          title={t('settings:features.autoReviewPickModel')}
          hint={t('settings:features.autoReviewPickModelHint')}
          fallbackProfiles={fallbackProfiles}
          onPick={(result) => {
            if (result.type === 'provider-model') {
              syncPref('autoReviewProvider', result.provider);
              syncPref('autoReviewModel', result.model);
              // Clearing the profile means: use the explicit provider/model
              // override (no named profile) — same effect as the user
              // explicitly setting the profile dropdown to "(none)".
              syncPref('autoReviewFallbackProfile', '');
            } else if (result.type === 'fallback-profile') {
              syncPref('autoReviewProvider', '');
              syncPref('autoReviewModel', '');
              syncPref('autoReviewFallbackProfile', result.name);
            } else if (result.type === 'clear') {
              syncPref('autoReviewProvider', '');
              syncPref('autoReviewModel', '');
              syncPref('autoReviewFallbackProfile', '');
            }
            setAutoReviewPickerOpen(false);
          }}
          onClose={closeAutoReviewPicker}
        />
      )}
    </div>
  );
}
