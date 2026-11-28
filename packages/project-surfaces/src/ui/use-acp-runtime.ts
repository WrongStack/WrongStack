import type {
  AcpNativeModeChoice,
  AcpNativeModeSelector,
  AcpRuntimeOption,
  AcpRuntimeOptionsResult,
  AcpRuntimeValues,
} from '@wrongstack/contracts/types/acp-runtime';
import { toErrorMessage } from '@wrongstack/core/utils/error';
import { useEffect, useRef, useState } from 'react';

export type AcpRuntimeRequest = (
  agentId: string,
  values: AcpRuntimeValues,
) => Promise<AcpRuntimeOptionsResult>;

export type AcpModeRequest = (
  agentId: string,
  choice?: AcpNativeModeChoice,
) => Promise<{ modes: AcpNativeModeSelector[] }>;

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

export function isModelOption(option: AcpRuntimeOption): boolean {
  return option.category === 'model' || option.id === 'model';
}

export function isEffortOption(option: AcpRuntimeOption): boolean {
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

/**
 * The state behind an ACP agent's model / effort / mode controls: options come from a private
 * agent session, modes from the live one, and saving configures the next turn or subagent start.
 * Shared by the full settings control and the composer's compact chip.
 */
export function useAcpRuntime({
  agentId,
  values = {},
  request,
  modeRequest,
  onChange,
}: {
  agentId: string;
  values?: AcpRuntimeValues | undefined;
  request: AcpRuntimeRequest;
  modeRequest?: AcpModeRequest | undefined;
  onChange: (values: AcpRuntimeValues) => void | Promise<void>;
}) {
  const [result, setResult] = useState<AcpRuntimeOptionsResult>();
  const [modeSelectors, setModeSelectors] = useState<AcpNativeModeSelector[]>();
  const [modeBusy, setModeBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingValues, setPendingValues] = useState<AcpRuntimeValues | undefined>();
  const [error, setError] = useState('');
  const sequence = useRef(0);
  useEffect(() => {
    sequence.current++;
    setResult(undefined);
    setModeSelectors(undefined);
    setModeBusy(false);
    setPendingValues(undefined);
    setError('');
    setBusy(false);
    setSaving(false);
    return () => {
      sequence.current++;
    };
  }, [agentId]);

  const loadModes = async (choice?: AcpNativeModeChoice) => {
    if (!modeRequest) return;
    const version = sequence.current;
    setModeBusy(true);
    if (choice) setError('');
    try {
      const response = await modeRequest(agentId, choice);
      if (sequence.current !== version) return;
      setModeSelectors(response.modes);
    } catch (e) {
      if (sequence.current === version && choice) setError(toErrorMessage(e));
    } finally {
      if (sequence.current === version) setModeBusy(false);
    }
  };

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

  return {
    result,
    modeSelectors,
    modeBusy,
    busy,
    saving,
    pendingValues,
    error,
    summary,
    load,
    loadModes,
    applySelection,
  };
}
