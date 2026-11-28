import type {
  AcpNativeModeChoice,
  AcpNativeModeSelector,
  AcpRuntimeOptionsResult,
  AcpRuntimeValues,
} from '@wrongstack/contracts/types/acp-runtime';
import { AcpRuntimeControls } from '@wrongstack/project-surfaces/ui/AcpRuntimeControls';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineCommand } from './engine-operations';

export function AcpRuntimeSettings({
  agentId,
  values,
  command,
  onChange,
  disabled,
}: {
  agentId: string;
  values?: AcpRuntimeValues | undefined;
  command: EngineCommand;
  onChange: (values: AcpRuntimeValues) => void | Promise<void>;
  disabled?: boolean | undefined;
}) {
  return (
    <AcpRuntimeControls
      agentId={agentId}
      values={values}
      disabled={disabled}
      onChange={onChange}
      request={async (id, selected) => {
        const result = await command(
          'acp.config_options',
          { agentId: id, values: selected },
          ['acp.config_options'],
          { timeoutMs: 100_000 },
        );
        if (result['ok'] !== true)
          throw Error(String(result['error'] ?? 'ACP settings request failed.'));
        return result as unknown as AcpRuntimeOptionsResult;
      }}
    />
  );
}

/** The adapter's own selectors for the live session, independent of model/effort discovery. */
export function AcpSessionModes({
  agentId,
  sessionId,
  connected,
  running,
  disabled,
  command,
}: {
  agentId: string;
  sessionId: string;
  connected: boolean;
  running: boolean;
  disabled: boolean;
  command: EngineCommand;
}) {
  const [modes, setModes] = useState<AcpNativeModeSelector[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const load = useCallback(
    async (choice?: AcpNativeModeChoice) => {
      const version = ++sequence.current;
      setBusy(true);
      setError('');
      try {
        const result = await command('acp.mode', { agentId, sessionId, ...choice }, ['acp.mode'], {
          timeoutMs: 100_000,
        });
        if (sequence.current !== version) return;
        if (result['ok'] !== true)
          throw Error(String(result['error'] ?? 'ACP mode request failed.'));
        setModes((result['modes'] as AcpNativeModeSelector[] | undefined) ?? []);
      } catch (failure) {
        if (sequence.current === version)
          setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        if (sequence.current === version) setBusy(false);
      }
    },
    [agentId, sessionId, command],
  );
  useEffect(() => {
    if (connected && sessionId && !running) void load();
    return () => {
      sequence.current++;
    };
  }, [connected, sessionId, running, load]);

  return (
    <>
      {modes.map((selector) => (
        <label
          key={selector.id}
          className="composer-chip effort-control"
          title={selector.description}
        >
          <span className="composer-setting-name">ACP {selector.name}</span>
          <select
            aria-label={`ACP ${selector.name}`}
            disabled={
              !connected || disabled || running || busy || !selector.selectableValues.length
            }
            value={selector.currentValue}
            onChange={(event) => {
              const value = event.target.value;
              if (selector.selectableValues.includes(value))
                void load({ optionId: selector.id, value });
            }}
          >
            {!selector.options.some((option) => option.value === selector.currentValue) && (
              <option value={selector.currentValue}>{selector.currentValue}</option>
            )}
            {selector.options.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={!selector.selectableValues.includes(option.value)}
              >
                {option.name}
              </option>
            ))}
          </select>
        </label>
      ))}
      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
