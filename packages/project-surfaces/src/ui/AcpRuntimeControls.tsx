import type {
  AcpRuntimeOption,
  AcpRuntimeOptionsResult,
  AcpRuntimeValues,
} from '@wrongstack/contracts/types/acp-runtime';
import { toErrorMessage } from '@wrongstack/core/utils/error';
import { useEffect, useRef, useState } from 'react';
import { useAppTranslation } from '../lib/i18n';

export type AcpRuntimeRequest = (
  agentId: string,
  values: AcpRuntimeValues,
) => Promise<AcpRuntimeOptionsResult>;

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
  // Changing provider invalidates both the selected model and its dependent effort levels.
  if (option.id === 'provider') {
    return { [option.id]: value };
  }
  // Changing model keeps provider (if any) and clears dependent effort options so
  // an incompatible effort from the previous model is never sent to the new model.
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
  const [saving, setSaving] = useState(false);
  const [pendingValues, setPendingValues] = useState<AcpRuntimeValues | undefined>();
  const [error, setError] = useState('');
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const sequence = useRef(0);
  useEffect(() => {
    sequence.current++;
    setResult(undefined);
    setPendingValues(undefined);
    setError('');
    setBusy(false);
    setSaving(false);
    return () => {
      sequence.current++;
    };
  }, [agentId]);

  const load = async (next: AcpRuntimeValues, save: boolean) => {
    const version = ++sequence.current;
    setBusy(true);
    setSaving(save);
    setPendingValues(save ? next : undefined);
    setError('');
    try {
      const response = await request(agentId, next);
      if (sequence.current !== version) return;
      if (save) await onChange(next);
      if (sequence.current === version) {
        setResult(response);
        setPendingValues(undefined);
      }
    } catch (e) {
      if (sequence.current === version) {
        setError(toErrorMessage(e));
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
    const next = nextValuesForChange(option, value, values, result.options);
    void load(next, true);
  };

  const summary = summaryLabel(result, values, pendingValues);

  return (
    <details
      ref={detailsRef}
      className="acp-runtime-controls min-w-0 max-w-full rounded-md border border-border/60 bg-card/60 px-2.5 py-1.5 text-xs"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && detailsRef.current?.open) {
          event.stopPropagation();
          detailsRef.current.open = false;
        }
      }}
      onToggle={(event) => {
        if (event.currentTarget.open && !result && !busy) void load(values, false);
      }}
    >
      <summary className="cursor-pointer select-none">
        <span>{t('activity:acp.runtimeTitle', { defaultValue: 'ACP · Model / effort' })}</span>
        {summary && <span className="opacity-80"> · {summary}</span>}
      </summary>
      <div className="grid min-w-0 gap-2.5 pt-2">
        <small className="text-muted-foreground">
          {t('activity:acp.runtimeHint', {
            defaultValue: 'Applies on the next turn or subagent start.',
          })}
        </small>
        {busy && (
          <span role="status" className="text-muted-foreground">
            {saving
              ? t('activity:acp.runtimeSaving', { defaultValue: 'Applying agent settings…' })
              : t('activity:acp.runtimeLoading', { defaultValue: 'Reading agent settings…' })}
          </span>
        )}
        {result?.options.map((option) => {
          const selectedValue = pendingValues?.[option.id] ?? option.currentValue;
          const showEffortPills =
            isEffortOption(option) && option.options.length >= 2 && option.options.length <= 6;
          return (
            <div key={option.id} className="grid min-w-0 gap-1">
              <label className="grid min-w-0 gap-1" title={option.description}>
                <span className="font-medium text-foreground/90">{option.name}</span>
                <select
                  className="w-full min-w-0 max-w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
                  aria-label={`ACP ${option.name}`}
                  disabled={disabled || busy}
                  value={selectedValue}
                  onChange={(event) => applySelection(option, event.target.value)}
                >
                  {!option.options.some((x) => x.value === selectedValue) && (
                    <option className="bg-background text-foreground" value={selectedValue}>
                      {selectedValue}
                    </option>
                  )}
                  {option.options.map((x) => (
                    <option key={x.value} className="bg-background text-foreground" value={x.value}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
              {showEffortPills && (
                <fieldset
                  className="acp-effort-pills m-0 flex flex-wrap gap-1 border-0 p-0 pt-0.5"
                  aria-label={`${option.name} quick select`}
                >
                  {option.options.map((choice) => {
                    const active = choice.value === selectedValue;
                    return (
                      <button
                        key={choice.value}
                        type="button"
                        aria-pressed={active}
                        disabled={disabled || busy}
                        className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
                          active
                            ? 'border-primary bg-primary/15 font-medium text-foreground'
                            : 'border-border/60 bg-transparent text-muted-foreground hover:border-border hover:text-foreground'
                        }`}
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
              {option.description && (
                <small className="acp-option-desc text-[11px] text-muted-foreground">
                  {option.description}
                </small>
              )}
            </div>
          );
        })}
        {result && !result.options.length && (
          <span className="text-muted-foreground">
            {t('activity:acp.runtimeUnsupported', {
              defaultValue: 'This agent does not expose model or effort settings through ACP.',
            })}
          </span>
        )}
        {error && (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            className="rounded border border-border/60 px-2 py-1 text-xs hover:bg-accent/50 disabled:opacity-50"
            disabled={busy || disabled}
            onClick={() => void load(values, false)}
          >
            {t('activity:acp.runtimeRefresh', { defaultValue: 'Refresh' })}
          </button>
          <button
            type="button"
            className="rounded border border-border/60 px-2 py-1 text-xs hover:bg-accent/50 disabled:opacity-50"
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
