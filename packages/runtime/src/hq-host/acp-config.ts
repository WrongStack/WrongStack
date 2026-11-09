import type { Config } from '@wrongstack/contracts/types';
import type {
  AcpRuntimeSelections,
  AcpRuntimeValues,
} from '@wrongstack/contracts/types/acp-runtime';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import { setSessionAcpRuntime } from '@wrongstack/coordination';
import { inspectAcpRuntime } from '@wrongstack/fleet';
import { type HqAcpConfigCommand, isHqAcpConfigResult } from '@wrongstack/hq';

const canonical = (values: AcpRuntimeValues) =>
  JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
const writes = new WeakMap<AgentContext, Promise<void>>();
const observers = new Set<(ctx: AgentContext, settings: AcpRuntimeSelections) => void>();
/** Local surfaces sharing the host mirror an acknowledged remote change immediately. */
export function onHqAcpConfigSaved(
  listener: (ctx: AgentContext, settings: AcpRuntimeSelections) => void,
): () => void {
  observers.add(listener);
  return () => {
    observers.delete(listener);
  };
}

export function createHqAcpConfigHandler(input: {
  getConfig: () => Config;
  context: (sessionId: string) => AgentContext | undefined;
  onSaved?: ((sessionId: string, settings: AcpRuntimeSelections) => void) | undefined;
}) {
  return async (command: HqAcpConfigCommand) => {
    const ctx = input.context(command.sessionId);
    const execute = async () => {
      const current = () => {
        if (
          !ctx ||
          input.context(command.sessionId) !== ctx ||
          ctx.session.id !== command.sessionId ||
          ctx.provider.id !== 'acp' ||
          ctx.model !== command.agentId
        )
          throw Error(
            'The selected ACP leader is no longer active in this session. Refresh before changing settings.',
          );
        return (
          (ctx.meta['acpRuntime'] as AcpRuntimeSelections | undefined)?.[command.agentId] ?? {}
        );
      };
      const prior = current();
      if (command.action === 'set' && canonical(prior) !== canonical(command.expected!))
        throw Error('ACP settings changed since they were read. Refresh before saving.');
      const values = command.action === 'set' ? command.values! : prior;
      const projectRoot = ctx!.projectRoot;
      const result = await inspectAcpRuntime(
        input.getConfig(),
        projectRoot,
        command.agentId,
        values,
      );
      if (!isHqAcpConfigResult(result))
        throw Error(
          'The agent settings response exceeds the remote response limit or is malformed.',
        );
      if (canonical(current()) !== canonical(prior))
        throw Error('ACP settings changed during validation. Refresh before saving.');
      if (ctx!.projectRoot !== projectRoot)
        throw Error('The session project changed during validation. Refresh before saving.');
      if (command.action === 'set') {
        const settings = ctx!.meta['acpRuntime'] as AcpRuntimeSelections | undefined;
        const next = { ...settings, [command.agentId]: values };
        await setSessionAcpRuntime(ctx!, next);
        for (const listener of observers) {
          try {
            listener(ctx!, structuredClone(next));
          } catch {
            /* A disconnected surface does not undo persistence. */
          }
        }
        try {
          input.onSaved?.(command.sessionId, next);
        } catch {
          /* Notification failure does not undo a journaled selection. */
        }
      }
      return result;
    };
    if (command.action !== 'set' || !ctx) return execute();
    const run = (writes.get(ctx) ?? Promise.resolve()).then(execute);
    const settled = run.then(
      () => {},
      () => {},
    );
    writes.set(ctx, settled);
    void settled.then(() => {
      if (writes.get(ctx) === settled) writes.delete(ctx);
    });
    return run;
  };
}
