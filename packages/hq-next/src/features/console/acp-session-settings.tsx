'use client';
import type {
  AcpRuntimeOptionsResult,
  AcpRuntimeValues,
} from '@wrongstack/contracts/types/acp-runtime';
import { useEffect, useRef, useState } from 'react';
import { requestAcpSettings } from './acp-settings-request';

export function AcpSessionSettings({
  clientId,
  sessionId,
  agentId,
  supported,
  connected,
}: {
  clientId: string;
  sessionId: string;
  agentId: string;
  supported: boolean;
  connected: boolean;
}) {
  const [result, setResult] = useState<AcpRuntimeOptionsResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    setResult(undefined);
    setError('');
    setBusy(false);
    sequence.current++;
    return () => {
      sequence.current++;
      pending.current?.abort();
    };
  }, [clientId, sessionId, agentId]);
  const load = async (values?: AcpRuntimeValues) => {
    const version = ++sequence.current;
    pending.current?.abort();
    pending.current = new AbortController();
    setBusy(true);
    setError('');
    try {
      const next = await requestAcpSettings(
        clientId,
        sessionId,
        agentId,
        values ? { values, expected: result?.applied ?? {} } : undefined,
        pending.current.signal,
      );
      if (sequence.current === version) setResult(next);
    } catch (e) {
      if (sequence.current === version) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (sequence.current === version) setBusy(false);
    }
  };
  return (
    <details
      className="min-w-0 max-w-full border border-primary/30 bg-primary/5 p-2 text-xs"
      data-acp-session-settings
      onToggle={(event) => {
        if (event.currentTarget.open && supported && connected && !result && !busy) void load();
      }}
    >
      <summary className="cursor-pointer break-all">
        ACP · Model / effort
        {result && Object.keys(result.applied).length
          ? ` · ${Object.values(result.applied).join(' / ')}`
          : ''}
      </summary>
      <div className="grid min-w-0 gap-2 pt-2">
        <p>
          Controls this session on the connected machine. Applies to the next turn or subagent
          start.
        </p>
        {!supported ? (
          <p>Restart this client with a current build to enable remote ACP settings.</p>
        ) : !connected ? (
          <p>The client is disconnected.</p>
        ) : (
          <>
            {busy && <p role="status">Waiting for the machine…</p>}
            {result?.options.map((option) => (
              <label key={option.id} className="grid min-w-0 gap-1" title={option.description}>
                {option.name}
                <select
                  className="min-w-0 max-w-full border border-border bg-background p-1"
                  aria-label={`ACP ${option.name}`}
                  value={option.currentValue}
                  disabled={busy}
                  onChange={(event) => {
                    const prior = result.applied;
                    const values =
                      option.category === 'model' || option.id === 'provider'
                        ? Object.fromEntries(
                            Object.entries(prior).filter(([id]) =>
                              result.options.some(
                                (x) =>
                                  x.id === id && (x.category === 'model' || x.id === 'provider'),
                              ),
                            ),
                          )
                        : prior;
                    void load({ ...values, [option.id]: event.target.value });
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
              <p>This agent does not expose model or effort settings through ACP.</p>
            )}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            <div className="flex gap-3">
              <button type="button" disabled={busy} onClick={() => void load()}>
                Refresh
              </button>
              <button
                type="button"
                disabled={busy || !result || !Object.keys(result.applied).length}
                onClick={() => void load({})}
              >
                Use defaults
              </button>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
