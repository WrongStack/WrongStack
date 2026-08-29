import { Zap } from 'lucide-react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import {
  AUTO_EFFORT,
  effortControlHidden,
  effortLabelKey,
  effortNotAdvertised,
  isEffort,
  resolveEffortOptions,
} from '@/lib/reasoning-effort';
import { useLocalPrefs } from '@/stores/local-prefs';
import { useSessionStore } from '@/stores/session-store';

/**
 * Per-session reasoning effort, inline in the composer toolbar next to the
 * model chip. `auto` = follow the project-wide setting; the remaining options
 * narrow to the levels the active model documents. Hidden entirely when the
 * model documents that it has no effort control — the tri-state keeps
 * `undefined` (undocumented vocabulary) visible with the full canonical set,
 * matching the runtime resolver's conservative gate. Writes the session-
 * scoped reasoningEffort pref via the same trip as the QuickModelSwitcher
 * select (local set + prefs.update), so every effort surface stays in step.
 *
 * While `auto` is picked, a small hint under the select shows the LIVE
 * project-wide effort it follows (from the session.start snapshot); absent
 * when the project pins no effort — then the provider default applies.
 */
export function SessionEffortSelect() {
  const { t } = useAppTranslation();
  const { updatePrefs } = useWebSocket();
  const effortSupported = useSessionStore((s) => s.effortSupported);
  const effortLevels = useSessionStore((s) => s.reasoningEffortLevels);
  const projectEffort = useSessionStore((s) => s.projectReasoningEffort);
  const reasoningEffort = useLocalPrefs((s) => s.reasoningEffort);

  if (effortControlHidden(effortSupported)) return null;

  const options = resolveEffortOptions(effortLevels, reasoningEffort);
  const unsupported = effortNotAdvertised(effortLevels, reasoningEffort);
  const label = t('settings:agent.reasoningEffortLabel');
  const autoHint =
    reasoningEffort === AUTO_EFFORT && projectEffort
      ? t('settings:agent.reasoningEffortAutoHint', {
          value: isEffort(projectEffort) ? t(effortLabelKey(projectEffort)) : projectEffort,
        })
      : undefined;

  return (
    <span className="inline-flex shrink-0 flex-col items-stretch gap-0.5">
      <label
        className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-card/50 px-2 py-1.5 text-xs text-muted-foreground transition-all duration-200 hover:border-primary/30 hover:bg-accent/50 hover:text-foreground"
        title={
          unsupported
            ? t('settings:agent.reasoningEffortUnsupported', {
                levels: (effortLevels ?? []).join(', '),
              })
            : label
        }
      >
        <Zap className="h-3.5 w-3.5 shrink-0" />
        <span className="sr-only">{label}</span>
        <select
          aria-label={label}
          value={reasoningEffort}
          onChange={(e) => {
            const value = e.target.value;
            useLocalPrefs.getState().set({ reasoningEffort: value });
            updatePrefs({ reasoningEffort: value });
          }}
          className="cursor-pointer appearance-none bg-transparent text-xs outline-none"
        >
          {options.map((level) => (
            <option key={level} value={level}>
              {t(effortLabelKey(level))}
            </option>
          ))}
        </select>
        {unsupported && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />}
      </label>
      {autoHint && (
        <span className="pl-1 text-[10px] leading-tight text-muted-foreground">{autoHint}</span>
      )}
    </span>
  );
}
