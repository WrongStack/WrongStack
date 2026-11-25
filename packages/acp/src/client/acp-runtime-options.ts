import type { AcpRuntimeOption, AcpRuntimeValues } from '@wrongstack/contracts/types/acp-runtime';
import { acpRuntimeValuesError } from '@wrongstack/contracts/types/acp-runtime';
import type { SessionId } from '../types/acp-v1.js';

/** The part of an ACP session that runtime values touch; ACPSession satisfies it. */
export interface AcpRuntimeSession {
  openSession(): Promise<{ sessionId: SessionId }>;
  getConfigOptions(): AcpRuntimeOption[];
  setConfigOption(sessionId: SessionId, configId: string, value: string): Promise<void>;
}

const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const safePrefix = (value: string, max: number): string => {
  let end = Math.min(value.length, max);
  const lastKept = value.charCodeAt(end - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;
  return value.slice(0, end);
};
const applied = new WeakMap<
  AcpRuntimeSession,
  { original: AcpRuntimeValues; requested: AcpRuntimeValues; changedByModel: Set<string> }
>();
const ALLOWED_CATEGORIES = new Set([
  'model',
  'thought_level',
  'model_config',
  'reasoning',
  'reasoning_effort',
  'effort',
  'thinking',
]);

const ALLOWED_IDS = new Set([
  'provider',
  'model',
  'effort',
  'reasoning_effort',
  'thought_level',
  'thinking',
  'thinking_level',
  'reasoning',
]);

function isModelCategoryOrId(category: string | undefined, id: string): boolean {
  return category === 'model' || id === 'model';
}

/** Permission and automation modes are deliberately outside model configuration. */
export function acpRuntimeOptions(input: unknown): AcpRuntimeOption[] {
  return parseOptions(
    input,
    (raw, category) =>
      category !== 'mode' && (ALLOWED_CATEGORIES.has(String(category)) || ALLOWED_IDS.has(raw.id)),
  );
}

export function acpSessionModeOptions(input: unknown): AcpRuntimeOption[] {
  return parseOptions(
    input,
    (raw, category) =>
      raw.type === 'select' &&
      (category === 'mode' ||
        (category === undefined && raw.id === 'mode') ||
        (category === 'collaboration_mode' && raw.id === 'collaboration_mode')),
  ).map((option) => ({
    ...option,
    category: option.id === 'collaboration_mode' ? 'collaboration_mode' : 'mode',
  }));
}

function parseOptions(
  input: unknown,
  include: (raw: { id: string; type: string }, category: string | undefined) => boolean,
): AcpRuntimeOption[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  return input.slice(0, 64).flatMap((raw): AcpRuntimeOption[] => {
    if (
      !record(raw) ||
      (raw.type !== 'select' && raw.type !== 'boolean') ||
      typeof raw.id !== 'string' ||
      !raw.id ||
      raw.id.length > 2000 ||
      seen.has(raw.id)
    )
      return [];
    const isBool = raw.type === 'boolean';
    const currentValue = isBool
      ? typeof raw.currentValue === 'boolean'
        ? String(raw.currentValue)
        : typeof raw.currentValue === 'string' &&
            (raw.currentValue === 'true' || raw.currentValue === 'false')
          ? raw.currentValue
          : undefined
      : typeof raw.currentValue === 'string'
        ? raw.currentValue
        : undefined;
    if (currentValue === undefined) return [];
    if (!isBool && !Array.isArray(raw.options)) return [];
    if (acpRuntimeValuesError({ [raw.id]: currentValue })) return [];
    const category = typeof raw.category === 'string' ? raw.category : undefined;
    if (!include({ id: raw.id, type: raw.type }, category)) return [];
    const options = isBool
      ? [
          { value: 'true', name: 'Enabled' },
          { value: 'false', name: 'Disabled' },
        ]
      : (raw.options as unknown[])
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
    const inferredCategory =
      category ??
      (raw.id === 'model' ? 'model' : raw.id === 'provider' ? undefined : 'thought_level');
    return [
      {
        id: raw.id,
        name: typeof raw.name === 'string' ? safePrefix(raw.name, 2000) : raw.id,
        ...(isBool ? { type: 'boolean' as const } : {}),
        category: inferredCategory,
        description:
          typeof raw.description === 'string' ? safePrefix(raw.description, 2000) : undefined,
        currentValue,
        options,
      },
    ];
  });
}

/**
 * Parse ACP's legacy `models` session block (`{ currentModelId, availableModels }`)
 * into a canonical `AcpRuntimeOption` so agents that use `session/set_model`
 * instead of `configOptions` still expose a working model selector.
 */
export function acpLegacyModelOption(input: unknown): AcpRuntimeOption | undefined {
  if (!record(input)) return undefined;
  const currentModelId =
    typeof input['currentModelId'] === 'string' && input['currentModelId'].length > 0
      ? input['currentModelId']
      : undefined;
  const available = Array.isArray(input['availableModels']) ? input['availableModels'] : [];
  if (!available.length) return undefined;
  const options: { value: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const item of available.slice(0, 4096)) {
    if (!record(item)) continue;
    const rawId = item['modelId'] ?? item['id'];
    if (typeof rawId !== 'string' || !rawId || rawId.length > 2000 || seen.has(rawId)) continue;
    seen.add(rawId);
    const rawName =
      typeof item['name'] === 'string' && item['name'].length > 0 ? item['name'] : rawId;
    options.push({ value: rawId, name: safePrefix(rawName, 2000) });
  }
  if (!options.length) return undefined;
  const currentValue = currentModelId ?? options[0]!.value;
  if (acpRuntimeValuesError({ model: currentValue })) return undefined;
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue,
    options,
  };
}

/** Apply dependencies first, and re-read the agent's revised vocabulary after every change. */
export async function applyAcpRuntimeValues(
  session: AcpRuntimeSession,
  values: AcpRuntimeValues,
  onUnavailableRestore?: (id: string, value: string) => void,
): Promise<AcpRuntimeOption[]> {
  const invalid = acpRuntimeValuesError(values);
  if (invalid) throw new Error(invalid);
  const { sessionId } = await session.openSession();
  const state = applied.get(session) ?? {
    original: Object.fromEntries(session.getConfigOptions().map((x) => [x.id, x.currentValue])),
    requested: {},
    changedByModel: new Set<string>(),
  };
  // Retain the baseline even when a later dependent option is rejected.
  applied.set(session, state);
  const rank = (id: string) =>
    id === 'provider'
      ? 0
      : isModelCategoryOrId(session.getConfigOptions().find((x) => x.id === id)?.category, id)
        ? 1
        : 2;
  const replacingModel = Object.keys(values).some(
    (id) => rank(id) < 2 && state.requested[id] !== values[id],
  );
  const restoringModel = Object.keys(state.requested).some(
    (id) => rank(id) < 2 && !(id in values) && Object.hasOwn(state.original, id),
  );
  const restoreIds = Object.keys(state.original).filter(
    (id) =>
      !(id in values) &&
      (Object.hasOwn(state.requested, id) || (restoringModel && state.changedByModel.has(id))) &&
      !(replacingModel && rank(id) === 2),
  );
  const effective = {
    ...Object.fromEntries(restoreIds.map((id) => [id, state.original[id]!])),
    ...values,
  };
  for (const [id, value] of Object.entries(effective).sort(([a], [b]) => rank(a) - rank(b))) {
    const before = session.getConfigOptions();
    const option = before.find((x) => x.id === id);
    const offered = option?.options.some((x) => x.value === value);
    if (!Object.hasOwn(values, id) && !offered) {
      if (option?.currentValue === value) continue;
      if (onUnavailableRestore) {
        onUnavailableRestore(id, value);
        continue;
      }
      if (!Object.hasOwn(state.requested, id)) continue;
    }
    if (!option) throw new Error(`ACP agent does not advertise a model setting named "${id}"`);
    if (!offered)
      throw new Error(`ACP setting "${id}" does not offer "${value}" for the selected model`);
    if (option.currentValue === value) continue;
    await session.setConfigOption(sessionId, id, value);
    state.requested[id] = value;
    const after = session.getConfigOptions();
    if (id === 'provider' || isModelCategoryOrId(option.category, id)) {
      const afterValues = new Map(after.map((item) => [item.id, item.currentValue]));
      // Switching a model can reset its effort or other dependent settings without a separate write.
      for (const item of before) {
        if (
          item.id !== 'provider' &&
          !isModelCategoryOrId(item.category, item.id) &&
          Object.hasOwn(state.original, item.id) &&
          item.currentValue !== afterValues.get(item.id)
        ) {
          state.changedByModel.add(item.id);
        }
      }
    }
    if (after.find((x) => x.id === id)?.currentValue !== value)
      throw new Error(`ACP agent did not confirm "${id}" = "${value}"`);
  }
  state.requested = { ...values };
  if (!Object.keys(values).some((id) => rank(id) < 2)) state.changedByModel.clear();
  applied.set(session, state);
  return session.getConfigOptions();
}
