import { Lock } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { useLocalPrefs } from '@/stores/local-prefs';
import { PreferenceToggle } from './PreferenceToggle';

/**
 * The kinds of damage YOLO can be asked to keep confirming, in the order the
 * list renders: worst first, the two locked ones last.
 *
 * Mirrors `ALL_DESTRUCTIVE_KINDS` in core (`security/yolo-risk.ts`). It is
 * duplicated rather than imported because the browser bundle does not pull in
 * the core security module; `YoloConfirmList` parity is pinned by a test so
 * the two cannot drift.
 */
export const YOLO_CONFIRM_KINDS = [
  'disk-wipe',
  'system-halt',
  'delete-outside',
  'git-history',
  'publish',
  'download-and-run',
  'bulk-delete',
  'agent-state',
  'credential-bind',
] as const;

/**
 * The two kinds that can switch the approval system itself off, and so are
 * shown read-only: writing `trust.json` disables prompting for good, writing
 * `config.json` hooks is boot-time RCE, and binding a real API key to a chosen
 * endpoint exfiltrates it. All three are reachable by prompt injection.
 */
export const LOCKED_YOLO_CONFIRM_KINDS: ReadonlySet<string> = new Set([
  'agent-state',
  'credential-bind',
]);

export function YoloConfirmList({ syncPref }: { syncPref: (key: string, value: unknown) => void }) {
  const { t } = useAppTranslation();
  const localPrefs = useLocalPrefs();
  const confirmMap = localPrefs.yoloConfirm ?? {};

  // An absent key reads as "still asks". That is the fail-closed direction: a
  // truncated map, or one written by a build that did not know a kind yet,
  // leaves it gated rather than silently letting it run.
  const asks = (kind: string) => confirmMap[kind] !== false;

  const toggle = (kind: string) => {
    if (LOCKED_YOLO_CONFIRM_KINDS.has(kind)) return;
    // Send the WHOLE map, never a single key: the server replaces rather than
    // merges, so a partial payload would drop the user's other choices.
    const next: Record<string, boolean> = {};
    for (const k of YOLO_CONFIRM_KINDS) next[k] = k === kind ? !asks(kind) : asks(k);
    syncPref('yoloConfirm', next);
  };

  return (
    <div className="space-y-1">
      <p className="mb-3 text-xs text-muted-foreground">{t('settings:agent.yoloConfirmIntro')}</p>
      {YOLO_CONFIRM_KINDS.map((kind) => {
        const locked = LOCKED_YOLO_CONFIRM_KINDS.has(kind);
        return (
          <div key={kind} className={locked ? 'opacity-70' : undefined}>
            <PreferenceToggle
              label={
                locked
                  ? `${t(`settings:agent.yoloKind.${kind}.label`)} ${String.fromCharCode(0x00b7)} ${t('settings:agent.yoloKindLocked')}`
                  : t(`settings:agent.yoloKind.${kind}.label`)
              }
              hint={t(`settings:agent.yoloKind.${kind}.hint`)}
              value={asks(kind)}
              disabled={locked}
              onChange={() => toggle(kind)}
            />
          </div>
        );
      })}
      <p className="flex items-start gap-2 pt-2 text-xs text-muted-foreground">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{t('settings:agent.yoloConfirmLockedNote')}</span>
      </p>
    </div>
  );
}
