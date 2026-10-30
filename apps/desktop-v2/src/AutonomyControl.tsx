import { useState } from 'react';
import { AUTONOMY_MODES, type AutonomyMode } from './autonomy-model';
import type { EngineCommand } from './engine-operations';

/**
 * The conversation's continuation mode, changed only by the user (`autonomy.switch`). The
 * engine also saves the choice as the default for new conversations.
 */
export function AutonomyControl({
  mode,
  command,
  disabled,
}: {
  mode: AutonomyMode | '';
  command: EngineCommand;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
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
        {mode === '' && <option value="">Continuation: not reported</option>}
        {AUTONOMY_MODES.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
