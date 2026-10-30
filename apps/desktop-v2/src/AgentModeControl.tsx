import { useEffect, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';

export interface AgentMode {
  id: string;
  name: string;
  description: string;
}

/** The engine's `modes.list`: installed modes and the active one (`default` when none). */
export function agentModes(value: unknown): { modes: AgentMode[]; activeId: string } {
  const reply = record(value);
  return {
    modes: entries(reply['modes'])
      .filter((mode) => typeof mode['id'] === 'string' && mode['id'] !== 'default')
      .map((mode) => ({
        id: String(mode['id']),
        name: typeof mode['name'] === 'string' && mode['name'] ? mode['name'] : String(mode['id']),
        description: typeof mode['description'] === 'string' ? mode['description'] : '',
      })),
    activeId: typeof reply['activeId'] === 'string' ? reply['activeId'] : 'default',
  };
}

/**
 * The conversation's agent mode (`mode.switch`). Shown only when the engine has installed
 * modes; the engine records the switch in this conversation's transcript.
 */
export function AgentModeControl({
  command,
  announced,
  disabled,
}: {
  command: EngineCommand;
  /** The mode this conversation's latest `session.start` named, if any. */
  announced: string;
  disabled: boolean;
}) {
  const [list, setList] = useState<{ modes: AgentMode[]; activeId: string } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    void command('modes.list', {}, ['modes.list'])
      .then((reply) => setList(agentModes(reply)))
      .catch(() => {
        // An engine without a mode store has nothing to offer here.
      });
  }, [command]);
  if (!list || list.modes.length === 0) return null;
  const current = announced || list.activeId;
  const known = current === 'default' || list.modes.some((mode) => mode.id === current);
  return (
    <label
      className="composer-chip effort-control"
      title={
        error ||
        list.modes.find((mode) => mode.id === current)?.description ||
        'The agent mode for this conversation.'
      }
    >
      <select
        aria-label="Agent mode"
        value={current}
        disabled={disabled || busy}
        onChange={(event) => {
          const id = event.target.value;
          setBusy(true);
          setError('');
          void command('mode.switch', { id }, ['key.operation_result'])
            .then(() => setList({ ...list, activeId: id }))
            .catch((failure) =>
              setError(failure instanceof Error ? failure.message : String(failure)),
            )
            .finally(() => setBusy(false));
        }}
      >
        <option value="default">Default mode</option>
        {!known && <option value={current}>{current}</option>}
        {list.modes.map((mode) => (
          <option key={mode.id} value={mode.id}>
            {mode.name}
          </option>
        ))}
      </select>
    </label>
  );
}
