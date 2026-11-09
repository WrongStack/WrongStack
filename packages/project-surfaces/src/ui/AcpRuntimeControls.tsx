import type {
  AcpRuntimeOptionsResult,
  AcpRuntimeValues,
} from '@wrongstack/contracts/types/acp-runtime';
import { useEffect, useRef, useState } from 'react';
import { useAppTranslation } from '../lib/i18n';

export type AcpRuntimeRequest = (
  agentId: string,
  values: AcpRuntimeValues,
) => Promise<AcpRuntimeOptionsResult>;

/** Options come from a private agent session. Saving configures the next turn/spawn. */
export function AcpRuntimeControls({
  agentId,
  values = {},
  request,
  onChange,
  disabled = false,
}: {
  agentId: string;
  values?: AcpRuntimeValues | undefined;
  request: AcpRuntimeRequest;
  onChange: (values: AcpRuntimeValues) => void | Promise<void>;
  disabled?: boolean | undefined;
}) {
  const { t } = useAppTranslation();
  const [result, setResult] = useState<AcpRuntimeOptionsResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  useEffect(() => {
    sequence.current++;
    setResult(undefined);
    setError('');
    setBusy(false);
    return () => {
      sequence.current++;
    };
  }, [agentId]);
  const load = async (next: AcpRuntimeValues, save: boolean) => {
    const version = ++sequence.current;
    setBusy(true);
    setError('');
    try {
      const response = await request(agentId, next);
      if (sequence.current !== version) return;
      if (save) await onChange(next);
      if (sequence.current === version) setResult(response);
    } catch (e) {
      if (sequence.current === version) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (sequence.current === version) setBusy(false);
    }
  };
  return (
    <details
      className="acp-runtime-controls min-w-0 max-w-full rounded border p-2 text-xs"
      onToggle={(event) => {
        if (event.currentTarget.open && !result && !busy) void load(values, false);
      }}
    >
      <summary className="cursor-pointer">
        {t('activity:acp.runtimeTitle', { defaultValue: 'ACP · Model / effort' })}
        {Object.keys(values).length ? ` · ${Object.values(values).join(' / ')}` : ''}
      </summary>
      <div className="grid min-w-0 gap-2 pt-2">
        <small>
          {t('activity:acp.runtimeHint', {
            defaultValue: 'Applies on the next turn or subagent start.',
          })}
        </small>
        {busy && (
          <span role="status">
            {t('activity:acp.runtimeLoading', { defaultValue: 'Reading agent settings…' })}
          </span>
        )}
        {result?.options.map((option) => (
          <label key={option.id} className="grid min-w-0 gap-1" title={option.description}>
            <span>{option.name}</span>
            <select
              style={{ maxWidth: '100%', minWidth: 0, color: 'inherit', background: 'transparent' }}
              aria-label={`ACP ${option.name}`}
              disabled={disabled || busy}
              value={option.currentValue}
              onChange={(event) => {
                // A model/provider can replace the dependent effort vocabulary.
                const next =
                  option.category === 'model' || option.id === 'provider'
                    ? Object.fromEntries(
                        Object.entries(values).filter(([id]) =>
                          result.options.some(
                            (x) => x.id === id && (x.category === 'model' || x.id === 'provider'),
                          ),
                        ),
                      )
                    : { ...values };
                void load({ ...next, [option.id]: event.target.value }, true);
              }}
            >
              {!option.options.some((x) => x.value === option.currentValue) && (
                <option value={option.currentValue}>{option.currentValue}</option>
              )}
              {option.options.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        ))}
        {result && !result.options.length && (
          <span>
            {t('activity:acp.runtimeUnsupported', {
              defaultValue: 'This agent does not expose model or effort settings through ACP.',
            })}
          </span>
        )}
        {error && <span role="alert">{error}</span>}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => void load(values, false)}
          >
            {t('activity:acp.runtimeRefresh', { defaultValue: 'Refresh' })}
          </button>
          <button
            type="button"
            disabled={busy || disabled || !Object.keys(values).length}
            onClick={() => void load({}, true)}
          >
            {t('activity:acp.runtimeDefaults', { defaultValue: 'Use defaults' })}
          </button>
        </div>
      </div>
    </details>
  );
}
