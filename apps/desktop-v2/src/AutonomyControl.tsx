import { useState } from 'react';
import { AUTONOMY_MODES, sessionAutonomy } from './autonomy-model';
import type { EngineCommand } from './engine-operations';

/**
 * The conversation's continuation mode, changed only by the user (`autonomy.switch`). The
 * engine also saves the choice as the default for new conversations. Beside it, the
 * conversation's YOLO level, as the WebUI's session panel offers it.
 */
export function AutonomyControl({
  prefs,
  command,
  disabled,
}: {
  /** The conversation's preferences as the engine last reported them (`prefs.updated`). */
  prefs: Record<string, unknown> | undefined;
  command: EngineCommand;
  disabled: boolean;
}) {
  const { mode } = sessionAutonomy(prefs);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <>
      <label
        className="composer-chip effort-control"
        title={
          error ||
          'How this conversation continues after a turn. Also saved as the default for new conversations.'
        }
      >
        <select
          aria-label="Continuation mode"
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
          {mode === '' && <option value="">Continuation</option>}
          {AUTONOMY_MODES.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <YoloControl prefs={prefs ?? {}} command={command} disabled={disabled} />
    </>
  );
}

const YOLO_LEVELS = [
  ['off', 'Approvals on', 'Permission prompts are active.', { yolo: false, yoloPlus: false }],
  [
    'on',
    'YOLO',
    'Calls run without asking; damaging kinds still ask.',
    { yolo: true, yoloPlus: false },
  ],
  [
    'plus',
    'YOLO+',
    'Every call runs and nothing asks; deny rules still refuse.',
    { yolo: true, yoloPlus: true },
  ],
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
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const level = prefs['yoloPlus'] === true ? 'plus' : prefs['yolo'] === true ? 'on' : 'off';
  const current = YOLO_LEVELS.find(([id]) => id === level)!;
  return (
    <label className={`composer-chip effort-control yolo-${level}`} title={error || current[2]}>
      <select
        aria-label="YOLO level"
        value={level}
        disabled={disabled || busy}
        onChange={(event) => {
          const next = YOLO_LEVELS.find(([id]) => id === event.target.value);
          if (!next) return;
          setBusy(true);
          setError('');
          void command('prefs.update', next[3], ['key.operation_result'])
            .catch((failure) =>
              setError(failure instanceof Error ? failure.message : String(failure)),
            )
            .finally(() => setBusy(false));
        }}
      >
        {YOLO_LEVELS.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
