import type { SlashCommand } from '@wrongstack/contracts/types';
import type { AcpRuntimeOption, AcpRuntimeValues } from '@wrongstack/contracts/types/acp-runtime';
import {
  normalizeSubagentModelPlan,
  sessionAcpRuntime,
  setSessionAcpRuntime,
  setSessionSubagentModelPlan,
} from '@wrongstack/coordination';
import { stripAnsi, toErrorMessage } from '@wrongstack/core/utils';
import { inspectAcpRuntime } from '@wrongstack/fleet';
import { loadCachedAcpRegistry } from './acp-registry-cache.js';
import type { AcpCommandHost } from './host.js';

export async function configureAcpRuntime(
  rest: string,
  opts: AcpCommandHost,
  ctx: Parameters<SlashCommand['run']>[1],
): Promise<{ message: string }> {
  try {
    if (!ctx || !opts.configStore) throw Error('A live session is required.');
    const [target, ...tokens] = rest.split(/\s+/).filter(Boolean);
    const agentId = target ?? (ctx.provider?.configureNativeRuntime ? ctx.model : undefined);
    if (!agentId)
      throw Error('Usage: /acp config <agent> [--lane=N|--role=name] [option value|reset]');
    const laneFlag = tokens.find((x) => x.startsWith('--lane='));
    const roleFlag = tokens.find((x) => x.startsWith('--role='));
    if (laneFlag && roleFlag) throw Error('Choose a lane or role, not both.');
    const parts = tokens.filter((x) => x !== laneFlag && x !== roleFlag);
    const plan = normalizeSubagentModelPlan(ctx.meta['subagentModelPlan']);
    const lane = laneFlag ? Number(laneFlag.slice(7)) - 1 : undefined;
    if (lane !== undefined && (!Number.isInteger(lane) || lane < 0 || lane >= plan.slots.length))
      throw Error('Choose an existing lane number.');
    const role = roleFlag?.slice(7);
    if (roleFlag && (!role || ['__proto__', 'constructor', 'prototype'].includes(role)))
      throw Error('A valid role name is required.');
    if (parts.length === 1 && parts[0] !== 'reset')
      throw Error('Provide both option id and value.');
    if (!laneFlag && !roleFlag && ctx.model === agentId && ctx.provider?.configureNativeRuntime) {
      const { options, unavailableRestores } = await ctx.provider.configureNativeRuntime(
        agentId,
        ctx.session.id,
        parts.length
          ? (current) => {
              const settings = sessionAcpRuntime(ctx.session.id);
              const values = nextRuntimeValues(parts, settings[agentId] ?? {}, current);
              return {
                values,
                save: () => setSessionAcpRuntime(ctx, { ...settings, [agentId]: values }),
              };
            }
          : undefined,
      );
      return formatSettings(
        agentId,
        options,
        parts[0] === 'reset'
          ? ' — cleared conversation overrides'
          : parts.length
            ? ' — applied to this conversation'
            : '',
        unavailableRestores,
      );
    }

    const route = role
      ? (plan.roles?.[role] ?? {})
      : lane !== undefined
        ? plan.slots[lane]!
        : undefined;
    const settings = sessionAcpRuntime(ctx.session.id);
    const prior = route ? (route.modelRuntime?.acp?.[agentId] ?? {}) : (settings[agentId] ?? {});
    const live = opts.paths ? (await loadCachedAcpRegistry(opts.paths))?.byId : undefined;
    let next = prior;
    if (parts.length >= 2) {
      const current = await inspectAcpRuntime(
        opts.configStore.get(),
        opts.projectRoot,
        agentId,
        prior,
        live,
      );
      next = nextRuntimeValues(parts, prior, current.options);
    } else if (parts[0] === 'reset') {
      next = {};
    }
    const result = await inspectAcpRuntime(
      opts.configStore.get(),
      opts.projectRoot,
      agentId,
      next,
      live,
    );
    if (parts.length) {
      if (route) {
        const target = {
          ...route,
          ...(parts[0] === 'reset' ? {} : { provider: 'acp', model: agentId }),
          modelRuntime: {
            ...route.modelRuntime,
            acp: { ...route.modelRuntime?.acp, [agentId]: next },
          },
        };
        await setSessionSubagentModelPlan(
          ctx,
          role
            ? { ...plan, roles: { ...plan.roles, [role]: target } }
            : { ...plan, slots: plan.slots.map((slot, index) => (index === lane ? target : slot)) },
        );
      } else await setSessionAcpRuntime(ctx, { ...settings, [agentId]: next });
    }
    return formatSettings(
      agentId,
      result.options,
      parts.length ? ' — saved for next turn/spawn' : '',
    );
  } catch (error) {
    return { message: `ACP settings failed: ${toErrorMessage(error)}` };
  }
}

function nextRuntimeValues(
  parts: string[],
  prior: AcpRuntimeValues,
  options: AcpRuntimeOption[],
): AcpRuntimeValues {
  const [id, ...value] = parts;
  if (!id || id === 'reset') return {};
  const option = options.find((entry) => entry.id === id);
  let base = prior;
  if (option?.id === 'provider') {
    base = {};
  } else if (option?.category === 'model' || option?.id === 'model') {
    base =
      options.some((entry) => entry.id === 'provider') && prior.provider !== undefined
        ? { provider: prior.provider }
        : {};
  }
  return { ...base, [id]: value.join(' ').replace(/^"(.*)"$/, '$1') };
}

function formatSettings(
  agentId: string,
  options: AcpRuntimeOption[],
  summary: string,
  unavailableRestores: AcpRuntimeValues = {},
): { message: string } {
  const display = (value: string) => stripAnsi(value).replace(/\p{Cc}/gu, ' ');
  return {
    message: [
      `ACP ${display(agentId)}${summary}`,
      ...options.map(
        (option) =>
          `${display(option.id)}: ${display(option.currentValue)}\n  ${option.options.map((choice) => display(choice.value)).join(' | ')}`,
      ),
      ...(!options.length ? ['No model or effort settings advertised.'] : []),
      ...Object.entries(unavailableRestores).map(
        ([id, value]) =>
          `Previous value "${display(value)}" is unavailable for ${display(id)} in this session.`,
      ),
    ].join('\n'),
  };
}
