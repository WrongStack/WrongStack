import { useState } from 'react';
import { AUTONOMY_MODES, autonomyModeAvailable, sessionAutonomy } from './autonomy-model';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';

/**
 * The conversation's continuation mode, changed only by the user (`autonomy.switch`). The
 * engine also saves the choice as the default for new conversations. Beside it, the
 * conversation's YOLO level, as the WebUI's session panel offers it. Modes the engine cannot
 * run (eternal ones, unless it announces an eternal driver) stay listed but cannot be chosen.
 */
export function AutonomyControl({
  prefs,
  sessionStart,
  command,
  disabled,
}: {
  /** The conversation's preferences as the engine last reported them (`prefs.updated`). */
  prefs: Record<string, unknown> | undefined;
  /** The engine's `session.start`, which says which modes it can run. */
  sessionStart?: unknown;
  command: EngineCommand;
  disabled: boolean;
}) {
  const { t } = useDesktopText();
  const { mode } = sessionAutonomy(prefs);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <>
      <label
        className="composer-chip effort-control"
        title={
          error ||
          // A conversation already on a mode this engine cannot run says why it does nothing.
          (mode && !autonomyModeAvailable(mode, sessionStart)
            ? t('autonomyControl.eternalUnavailable')
            : t('autonomyControl.title'))
        }
      >
        <select
          aria-label={t('autonomyControl.label')}
          value={mode}
          disabled={disabled || busy}
          onChange={(event) => {
            setBusy(true);
            setError('');
            void command('autonomy.switch', { mode: event.target.value }, ['key.operation_result'])
              .catch((failure) =>
                setError(failure instanceof Error ? failure.message : String(failure)),
              )
              .finally(() => setBusy(false));
          }}
        >
          {mode === '' && <option value="">{t('autonomyControl.placeholder')}</option>}
          {AUTONOMY_MODES.map(([id, label]) => {
            const available = autonomyModeAvailable(id, sessionStart);
            return (
              <option
                key={id}
                value={id}
                disabled={!available}
                title={available ? undefined : t('autonomyControl.eternalUnavailable')}
              >
                {t(`autonomyControl.mode.${id}`, { defaultValue: label })}
              </option>
            );
          })}
        </select>
      </label>
      <YoloControl prefs={prefs ?? {}} command={command} disabled={disabled} />
    </>
  );
}

/** What the control reads from the engine: the conversation's preferences and `session.start`. */
export function autonomyControlInputs(results: Readonly<Record<string, Record<string, unknown>>>): {
  prefs: Record<string, unknown> | undefined;
  sessionStart: unknown;
} {
  return { prefs: results['prefs.updated'], sessionStart: results['session.start'] };
}

const YOLO_LEVELS = [
  ['off', { yolo: false, yoloPlus: false }],
  ['on', { yolo: true, yoloPlus: false }],
  ['plus', { yolo: true, yoloPlus: true }],
] as const;

/** The conversation's YOLO level, saved with `prefs.update` as `/yolo` saves it. */
function YoloControl({
  prefs,
  command,
  disabled,
}: {
  prefs: Record<string, unknown>;
  command: EngineCommand;
  disabled: boolean;
}) {
  const { t } = useDesktopText();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const level = prefs['yoloPlus'] === true ? 'plus' : prefs['yolo'] === true ? 'on' : 'off';
  return (
    <label
      className={`composer-chip effort-control yolo-${level}`}
      title={error || t(`autonomyControl.yolo.${level}Title`)}
    >
      <select
        aria-label={t('autonomyControl.yoloLabel')}
        value={level}
        disabled={disabled || busy}
        onChange={(event) => {
          const next = YOLO_LEVELS.find(([id]) => id === event.target.value);
          if (!next) return;
          setBusy(true);
          setError('');
          void command('prefs.update', next[1], ['key.operation_result'])
            .catch((failure) =>
              setError(failure instanceof Error ? failure.message : String(failure)),
            )
            .finally(() => setBusy(false));
        }}
      >
        {YOLO_LEVELS.map(([id]) => (
          <option key={id} value={id}>
            {t(`autonomyControl.yolo.${id}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
