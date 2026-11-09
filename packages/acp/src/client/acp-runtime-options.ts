import type { AcpRuntimeOption, AcpRuntimeValues } from '@wrongstack/contracts/types/acp-runtime';
import { acpRuntimeValuesError } from '@wrongstack/contracts/types/acp-runtime';
import type { ACPSession } from './acp-session.js';

const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const applied = new WeakMap<
  ACPSession,
  { original: AcpRuntimeValues; requested: AcpRuntimeValues }
>();
/** Permission and automation modes are deliberately outside model configuration. */
export function acpRuntimeOptions(input: unknown): AcpRuntimeOption[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  return input.slice(0, 64).flatMap((raw): AcpRuntimeOption[] => {
    if (
      !record(raw) ||
      raw.type !== 'select' ||
      typeof raw.id !== 'string' ||
      !raw.id ||
      seen.has(raw.id) ||
      typeof raw.currentValue !== 'string' ||
      !Array.isArray(raw.options)
    )
      return [];
    if (acpRuntimeValuesError({ [raw.id]: raw.currentValue })) return [];
    if (
      !['model', 'thought_level', 'model_config'].includes(String(raw.category)) &&
      raw.id !== 'provider'
    )
      return [];
    const options = raw.options
      .slice(0, 4096)
      .flatMap((group) =>
        record(group) && Array.isArray(group.options) ? group.options.slice(0, 4096) : [group],
      )
      .slice(0, 8192)
      .filter(
        (value) =>
          record(value) &&
          typeof value.value === 'string' &&
          value.value.length <= 2000 &&
          typeof value.name === 'string' &&
          value.name.length <= 2000,
      )
      .map((value) => ({ value: value.value as string, name: value.name as string }));
    if (!options.length) return [];
    seen.add(raw.id);
    return [
      {
        id: raw.id,
        name: typeof raw.name === 'string' ? raw.name : raw.id,
        category: typeof raw.category === 'string' ? raw.category : undefined,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        currentValue: raw.currentValue,
        options,
      },
    ];
  });
}

/** Apply dependencies first, and re-read the agent's revised vocabulary after every change. */
export async function applyAcpRuntimeValues(
  session: ACPSession,
  values: AcpRuntimeValues,
): Promise<AcpRuntimeOption[]> {
  const invalid = acpRuntimeValuesError(values);
  if (invalid) throw new Error(invalid);
  const { sessionId } = await session.openSession();
  const state = applied.get(session) ?? {
    original: Object.fromEntries(session.getConfigOptions().map((x) => [x.id, x.currentValue])),
    requested: {},
  };
  // Retain the baseline even when a later dependent option is rejected.
  applied.set(session, state);
  const rank = (id: string) =>
    id === 'provider'
      ? 0
      : session.getConfigOptions().find((x) => x.id === id)?.category === 'model'
        ? 1
        : 2;
  const replacingModel = Object.keys(values).some(
    (id) => rank(id) < 2 && state.requested[id] !== values[id],
  );
  const restoreIds = Object.keys(state.requested).filter(
    (id) =>
      !(id in values) && state.original[id] !== undefined && !(replacingModel && rank(id) === 2),
  );
  const effective = {
    ...Object.fromEntries(restoreIds.map((id) => [id, state.original[id]!])),
    ...values,
  };
  for (const [id, value] of Object.entries(effective).sort(([a], [b]) => rank(a) - rank(b))) {
    const option = session.getConfigOptions().find((x) => x.id === id);
    if (!option) throw new Error(`ACP agent does not advertise a model setting named "${id}"`);
    if (!option.options.some((x) => x.value === value))
      throw new Error(`ACP setting "${id}" does not offer "${value}" for the selected model`);
    if (option.currentValue === value) continue;
    await session.setConfigOption(sessionId, id, value);
    state.requested[id] = value;
    if (session.getConfigOptions().find((x) => x.id === id)?.currentValue !== value)
      throw new Error(`ACP agent did not confirm "${id}" = "${value}"`);
  }
  state.requested = { ...values };
  applied.set(session, state);
  return session.getConfigOptions();
}
