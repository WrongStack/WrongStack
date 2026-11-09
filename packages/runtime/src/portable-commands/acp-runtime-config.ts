import type { SlashCommand } from '@wrongstack/contracts/types';
import {
  normalizeSubagentModelPlan,
  sessionAcpRuntime,
  setSessionAcpRuntime,
  setSessionSubagentModelPlan,
} from '@wrongstack/coordination';
import { toErrorMessage } from '@wrongstack/core/utils';
import { inspectAcpRuntime } from '@wrongstack/fleet';
import type { AcpCommandHost } from './host.js';

export async function configureAcpRuntime(
  rest: string,
  opts: AcpCommandHost,
  ctx: Parameters<SlashCommand['run']>[1],
): Promise<{ message: string }> {
  try {
    if (!ctx || !opts.configStore) throw Error('A live session is required.');
    const [agentId, ...tokens] = rest.split(/\s+/).filter(Boolean);
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
    const route = role
      ? (plan.roles?.[role] ?? {})
      : lane !== undefined
        ? plan.slots[lane]!
        : undefined;
    const settings = sessionAcpRuntime(ctx.session.id);
    const prior = route ? (route.modelRuntime?.acp?.[agentId] ?? {}) : (settings[agentId] ?? {});
    let base = prior;
    if (parts.length >= 2) {
      const current = await inspectAcpRuntime(
        opts.configStore.get(),
        opts.projectRoot,
        agentId,
        prior,
      );
      const option = current.options.find((x) => x.id === parts[0]);
      if (option?.category === 'model' || option?.id === 'provider')
        base = Object.fromEntries(
          Object.entries(prior).filter(([id]) =>
            current.options.some(
              (x) => x.id === id && (x.category === 'model' || x.id === 'provider'),
            ),
          ),
        );
    }
    const next =
      parts[0] === 'reset'
        ? {}
        : parts.length >= 2
          ? {
              ...base,
              [parts[0]!]: parts
                .slice(1)
                .join(' ')
                .replace(/^"(.*)"$/, '$1'),
            }
          : prior;
    if (parts.length === 1 && parts[0] !== 'reset')
      throw Error('Provide both option id and value.');
    const result = await inspectAcpRuntime(opts.configStore.get(), opts.projectRoot, agentId, next);
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
    return {
      message: [
        `ACP ${agentId}${parts.length ? ' — saved for next turn/spawn' : ''}`,
        ...result.options.map(
          (x) => `${x.id}: ${x.currentValue}\n  ${x.options.map((y) => y.value).join(' | ')}`,
        ),
        ...(!result.options.length ? ['No model or effort settings advertised.'] : []),
      ].join('\n'),
    };
  } catch (error) {
    return { message: `ACP settings failed: ${toErrorMessage(error)}` };
  }
}
