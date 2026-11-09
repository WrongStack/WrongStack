'use client';
import type {
  AcpRuntimeOptionsResult,
  AcpRuntimeSelections,
  AcpRuntimeValues,
  ProtocolEnvelope,
} from '@wrongstack/webui-protocol';
import { useEffect, useRef, useState } from 'react';
import type { SessionState } from '../lib/session';

export function AcpRuntime({
  state,
  disabled,
  send,
  subscribe,
}: {
  state: SessionState;
  disabled: boolean;
  send: (type: string, payload: Record<string, unknown>) => boolean;
  subscribe: (listener: (frame: ProtocolEnvelope) => void) => () => void;
}) {
  const [result, setResult] = useState<AcpRuntimeOptionsResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const settings = (state.prefs.acpRuntime ?? {}) as AcpRuntimeSelections;
  const values = settings[state.model] ?? {};
  useEffect(() => {
    sequence.current++;
    setResult(undefined);
    setBusy(false);
    setError('');
    return () => {
      sequence.current++;
    };
  }, [state.id, state.model]);
  const request = (type: string, payload: Record<string, unknown>, reply: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(
        () => {
          off();
          reject(Error('ACP settings were not confirmed.'));
        },
        type === 'acp.config_options' ? 100_000 : 15_000,
      );
      const off = subscribe((frame) => {
        const p = (frame.payload ?? {}) as Record<string, unknown>;
        if (frame.type !== reply || p.requestId !== requestId) return;
        clearTimeout(timer);
        off();
        if (p.ok === false || p.success === false)
          reject(Error(String(p.error ?? p.message ?? 'ACP settings failed.')));
        else resolve(p);
      });
      if (!send(type, { ...payload, requestId })) {
        clearTimeout(timer);
        off();
        reject(Error('Connect before changing ACP settings.'));
      }
    });
  const load = async (next: AcpRuntimeValues, save = false) => {
    const version = ++sequence.current;
    setBusy(true);
    setError('');
    try {
      const response = await request(
        'acp.config_options',
        { agentId: state.model, values: next },
        'acp.config_options',
      );
      if (sequence.current !== version) return;
      if (save)
        await request(
          'prefs.update',
          { sessionId: state.id, acpRuntime: { ...settings, [state.model]: next } },
          'key.operation_result',
        );
      if (sequence.current === version) setResult(response as unknown as AcpRuntimeOptionsResult);
    } catch (e) {
      if (sequence.current === version) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (sequence.current === version) setBusy(false);
    }
  };
  return (
    <details
      className="acp-runtime-controls"
      onToggle={(e) => {
        if (e.currentTarget.open && !result && !busy) void load(values);
      }}
    >
      <summary>ACP · Model / effort</summary>
      <small>Applies on the next turn. Agent settings use this session only.</small>
      {busy && <span role="status">Reading agent settings…</span>}
      {result?.options.map((option) => (
        <label key={option.id}>
          {option.name}
          <select
            aria-label={`ACP ${option.name}`}
            disabled={busy || disabled}
            value={option.currentValue}
            onChange={(e) => {
              const next =
                option.category === 'model' || option.id === 'provider'
                  ? Object.fromEntries(
                      Object.entries(values).filter(([id]) =>
                        result.options.some(
                          (x) => x.id === id && (x.category === 'model' || x.id === 'provider'),
                        ),
                      ),
                    )
                  : values;
              void load({ ...next, [option.id]: e.target.value }, true);
            }}
          >
            {option.options.map((x) => (
              <option key={x.value} value={x.value}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
      ))}
      {result && !result.options.length && (
        <p>This agent does not expose model or effort settings through ACP.</p>
      )}
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={busy || disabled} onClick={() => void load(values)}>
        Refresh
      </button>
      <button
        type="button"
        disabled={busy || disabled || !Object.keys(values).length}
        onClick={() => void load({}, true)}
      >
        Use defaults
      </button>
    </details>
  );
}
