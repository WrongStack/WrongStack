import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Compactor, Config, ConfigStore, Logger } from '@wrongstack/contracts/types';
import type { Agent, AgentPipelines } from '@wrongstack/core/agent';
import { bridgeLifecycleHooks, HookRegistry, HookRunner } from '@wrongstack/core/hooks';
import { createLifecycleHooksExtension, installHostHooks } from '@wrongstack/runtime/plugin-host';
import {
  createWrongTraceHookPair,
  persistWrongTraceGateCounters,
  recordGateDecision,
  snapshotGateDecisions,
} from '@wrongstack/wrongtrace';

const WRONGTRACE_MATCHER = 'edit|write|replace|patch|codebase-ast-replace';

export interface StandaloneHooksInput {
  config: Config;
  configStore?: ConfigStore | undefined;
  pipelines: AgentPipelines;
  events: EventBus;
  logger: Logger;
  projectRoot: string;
  /** The leader context: its session id and cwd own this process's WrongTrace locks. */
  context: { session: { id: string }; cwd: string };
  /** Defaults to `WRONGSTACK_SAFE_MODE=1`, as the CLI reads it. */
  safeMode?: boolean | undefined;
}

export interface StandaloneHooks {
  /** User `config.hooks`, plugin hooks and the WrongTrace gate — the leader's registry. */
  hookRegistry: HookRegistry;
  /** What every tab's tool executor runs. */
  hookRunner: HookRunner;
  /** Goal / SDD workers: the fail-open WrongTrace gate only, never the user's hooks. */
  workerHookRunner: HookRunner;
  safeMode: boolean;
  /** SessionStart / Stop for one conversation's agent (one instance per agent). */
  attach(agent: Agent): void;
  /** PreCompact/PostCompact, SubagentStart/Stop, Notification and SessionEnd. */
  bridge(compactor: Compactor): void;
  dispose(): void;
}

/**
 * The standalone host's lifecycle hooks (CLI parity: cli/src/wiring/lifecycle-plugins.ts).
 *
 * Before this the engine's registry held only the WrongTrace gate, so the user's
 * `config.hooks` — including `policy: true` enforcement hooks meant to deny a
 * tool call — never fired for a desktop conversation. They now load through the
 * same `installHostHooks` the CLI calls, under the same gate: safe mode keeps
 * only policy hooks. Delegate and Goal/SDD workers keep the WrongTrace-only
 * runner, as the CLI's workers do.
 */
export function createStandaloneHooks(input: StandaloneHooksInput): StandaloneHooks {
  const { events, logger, context, projectRoot } = input;
  // The engine takes no flags: safe mode is the env form `--safe-mode` exports
  // to child processes (cli/src/boot/safe-mode.ts).
  const safeMode = input.safeMode ?? process.env['WRONGSTACK_SAFE_MODE'] === '1';
  const host = installHostHooks({
    config: input.config,
    hooksEnabled: !safeMode,
    pipelines: input.pipelines,
    logger,
    sessionId: () => context.session.id,
    configStore: input.configStore,
  });

  // WrongTrace guardrail: preToolUse denies edits to files locked by another
  // owner (peer agent) and claims the lock; postToolUse releases it. Owner
  // identity = THIS process's active session id — startWebUI is its own
  // process, never a copied CLI-leader closure. One pair: pre/post share one
  // lock set, registered on the leader's registry and on the workers' one.
  const wrongTraceHooks = createWrongTraceHookPair(() => context.session.id, {
    baseDir: () => context.cwd,
    emit: (event) => {
      events.emit('wrongtrace.gate.decision', event);
      // Shared counters contract (see adapter gate-counters.ts): this
      // process's tally is persisted per gate decision — the standalone
      // server has no single session-end hook, and last writer wins
      // against the CLI's session-end persist. `wstack proxy-status`
      // reads whatever the latest writer left.
      recordGateDecision(event);
      void persistWrongTraceGateCounters(projectRoot, snapshotGateDecisions());
    },
  });
  const registerWrongTrace = (registry: HookRegistry): void => {
    registry.registerInProcess(
      'PreToolUse',
      WRONGTRACE_MATCHER,
      wrongTraceHooks.preToolUse,
      'wrongtrace-gate',
    );
    registry.registerInProcess(
      'PostToolUse',
      WRONGTRACE_MATCHER,
      wrongTraceHooks.postToolUse,
      'wrongtrace-gate',
      // Also on a denied / rejected / failed call: release the lock PreToolUse took.
      { runWhenToolSkipped: true },
    );
  };
  registerWrongTrace(host.hookRegistry);
  const workerRegistry = new HookRegistry();
  registerWrongTrace(workerRegistry);
  const workerHookRunner = new HookRunner({
    registry: workerRegistry,
    sessionId: () => context.session.id,
    // Coordination, not enforcement: fail-open by construction.
    allowNonPolicy: true,
  });

  const detach: Array<() => void> = [host.dispose];
  const attached = new WeakSet<Agent>();
  return {
    hookRegistry: host.hookRegistry,
    hookRunner: host.hookRunner,
    workerHookRunner,
    safeMode,
    attach(agent) {
      if (attached.has(agent)) return;
      attached.add(agent);
      agent.extensions.register(createLifecycleHooksExtension(host.hookRunner));
    },
    bridge(compactor) {
      detach.push(
        bridgeLifecycleHooks({
          hookRunner: host.hookRunner,
          events,
          cwd: context.cwd,
          compactor,
          logger,
        }),
      );
    },
    dispose() {
      for (const off of detach.splice(0)) off();
    },
  };
}
