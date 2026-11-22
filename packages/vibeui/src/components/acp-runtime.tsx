'use client';
import type {
  AcpRuntimeOption,
  AcpRuntimeOptionsResult,
  AcpRuntimeSelections,
  AcpRuntimeValues,
  ProtocolEnvelope,
} from '@wrongstack/webui-protocol';
import { useEffect, useRef, useState } from 'react';
import { errorText } from '../lib/error-text';
import type { SessionState } from '../lib/session';

const EFFORT_CATEGORIES = new Set([
  'thought_level',
  'reasoning',
  'reasoning_effort',
  'effort',
  'thinking',
]);

const EFFORT_IDS = new Set([
  'effort',
  'thought',
  'thought_level',
  'reasoning_effort',
  'thinking',
  'thinking_level',
  'reasoning',
]);

function isModelOption(option: AcpRuntimeOption): boolean {
  return option.category === 'model' || option.id === 'model';
}

function isEffortOption(option: AcpRuntimeOption): boolean {
  if (isModelOption(option) || option.id === 'provider') return false;
  return (
    (option.category !== undefined && EFFORT_CATEGORIES.has(option.category)) ||
    EFFORT_IDS.has(option.id)
  );
}

function nextValuesForChange(
  option: AcpRuntimeOption,
  value: string,
  currentValues: AcpRuntimeValues,
  allOptions: AcpRuntimeOption[],
): AcpRuntimeValues {
  if (option.id === 'provider') return { [option.id]: value };
  if (isModelOption(option)) {
    const kept = Object.fromEntries(
      Object.entries(currentValues).filter(([id]) =>
        allOptions.some((x) => x.id === id && x.id === 'provider'),
      ),
    );
    return { ...kept, [option.id]: value };
  }
  return { ...currentValues, [option.id]: value };
}

function summaryLabel(
  result: AcpRuntimeOptionsResult | undefined,
  values: AcpRuntimeValues,
  pendingValues: AcpRuntimeValues | undefined,
): string {
  const active = pendingValues ?? values;
  if (result && result.options.length > 0) {
    const parts = result.options
      .map((option) => {
        const current = pendingValues?.[option.id] ?? option.currentValue;
        const matched = option.options.find((x) => x.value === current);
        return matched?.name ?? current;
      })
      .filter(Boolean);
    if (parts.length > 0) return parts.join(' / ');
  }
  const saved = Object.values(active).filter(Boolean);
  return saved.length > 0 ? saved.join(' / ') : '';
}

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
  const [saving, setSaving] = useState(false);
  const [pendingValues, setPendingValues] = useState<AcpRuntimeValues | undefined>();
  const [error, setError] = useState('');
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const sequence = useRef(0);
  const pendingCancels = useRef(new Set<() => void>());
  const settings = (state.prefs.acpRuntime ?? {}) as AcpRuntimeSelections;
  const values = settings[state.model] ?? {};
  useEffect(() => {
    sequence.current++;
    setResult(undefined);
    setPendingValues(undefined);
    setBusy(false);
    setSaving(false);
    setError('');
    return () => {
      sequence.current++;
      for (const cancel of [...pendingCancels.current]) cancel();
    };
  }, [state.id, state.model]);
  const request = (type: string, payload: Record<string, unknown>, reply: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      let settled = false;
      const cleanup = () => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        off();
        pendingCancels.current.delete(cancel);
        return true;
      };
      const cancel = () => {
        if (cleanup()) reject(Error('ACP settings request cancelled.'));
      };
      const timer = setTimeout(
        () => {
          if (cleanup()) reject(Error('ACP settings were not confirmed.'));
        },
        type === 'acp.config_options' ? 100_000 : 15_000,
      );
      const off = subscribe((frame) => {
        const p = (frame.payload ?? {}) as Record<string, unknown>;
        if (frame.type !== reply || p.requestId !== requestId) return;
        if (!cleanup()) return;
        if (p.ok === false || p.success === false)
          reject(Error(String(p.error ?? p.message ?? 'ACP settings failed.')));
        else resolve(p);
      });
      pendingCancels.current.add(cancel);
      try {
        if (!send(type, { ...payload, requestId })) {
          if (cleanup()) reject(Error('Connect before changing ACP settings.'));
        }
      } catch (err) {
        if (cleanup()) reject(err);
      }
    });
  const load = async (next: AcpRuntimeValues, save = false) => {
    const version = ++sequence.current;
    setBusy(true);
    setSaving(save);
    setPendingValues(save ? next : undefined);
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
      if (sequence.current === version) {
        setResult(response as unknown as AcpRuntimeOptionsResult);
        setPendingValues(undefined);
      }
    } catch (e) {
      if (sequence.current === version) {
        setError(errorText(e));
        setPendingValues(undefined);
      }
    } finally {
      if (sequence.current === version) {
        setBusy(false);
        setSaving(false);
      }
    }
  };
  const applySelection = (option: AcpRuntimeOption, value: string) => {
    if (!result) return;
    void load(nextValuesForChange(option, value, values, result.options), true);
  };
  const summary = summaryLabel(result, values, pendingValues);
  return (
    <details
      ref={detailsRef}
      className="acp-runtime-controls"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && detailsRef.current?.open) {
          e.stopPropagation();
          detailsRef.current.open = false;
        }
      }}
      onToggle={(e) => {
        if (e.currentTarget.open && !result && !busy) void load(values);
      }}
    >
      <summary>
        <span>ACP · Model / effort</span>
        {summary && <span> · {summary}</span>}
      </summary>
      <small>Applies on the next turn. Agent settings use this session only.</small>
      {busy && (
        <span role="status">{saving ? 'Applying agent settings…' : 'Reading agent settings…'}</span>
      )}
      {result?.options.map((option) => {
        const selectedValue = pendingValues?.[option.id] ?? option.currentValue;
        const showEffortPills =
          isEffortOption(option) && option.options.length >= 2 && option.options.length <= 6;
        return (
          <div key={option.id}>
            <label title={option.description}>
              {option.name}
              <select
                aria-label={`ACP ${option.name}`}
                disabled={busy || disabled}
                value={selectedValue}
                onChange={(e) => applySelection(option, e.target.value)}
              >
                {!option.options.some((x) => x.value === selectedValue) && (
                  <option value={selectedValue}>{selectedValue}</option>
                )}
                {option.options.map((x) => (
                  <option key={x.value} value={x.value}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
            {showEffortPills && (
              <fieldset className="acp-effort-pills" aria-label={`${option.name} quick select`}>
                {option.options.map((choice) => {
                  const active = choice.value === selectedValue;
                  return (
                    <button
                      key={choice.value}
                      type="button"
                      aria-pressed={active}
                      disabled={busy || disabled}
                      onClick={() => {
                        if (choice.value !== selectedValue) applySelection(option, choice.value);
                      }}
                    >
                      {choice.name}
                    </button>
                  );
                })}
              </fieldset>
            )}
            {option.description && <small className="acp-option-desc">{option.description}</small>}
          </div>
        );
      })}
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
