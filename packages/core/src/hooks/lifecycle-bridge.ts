import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { CompactionTrigger, Compactor } from '@wrongstack/contracts/types/compactor';
import type { Logger } from '@wrongstack/contracts/types/logger';
import { toErrorMessage } from '../utils/error.js';
import type { HookRunEnv, HookRunner } from './runner.js';
import { markUserInputObserver } from './user-input-observers.js';

export interface LifecycleHookBridgeOptions {
  hookRunner: HookRunner;
  events: EventBus;
  /** Working directory reported to hooks for bus-driven events. */
  cwd: string;
  /** The process compactor; PreCompact/PostCompact attach through it. */
  compactor?: Compactor | undefined;
  logger?: Logger | undefined;
}

/**
 * Drive the observational hook events from the places they actually happen:
 *
 *  - `PreCompact` / `PostCompact` — awaited around every compaction pass via
 *    the compactor's observer seam (auto, manual, overflow recovery and the
 *    context_manager tool all go through it);
 *  - `SubagentStart` / `SubagentStop` — `delegate.started` / `delegate.completed`;
 *  - `Notification` — a permission prompt (`tool.confirm_needed`) or a
 *    structured question (`user.input_requested`) is waiting on the user;
 *  - `SessionEnd` — `session.ended`, joined through its `waitUntil` so the
 *    hook finishes before the session closes.
 *
 * Bus-driven hooks never delay the emitter: they run detached, and a failure
 * is logged. Returns a function that removes every subscription.
 */
export function bridgeLifecycleHooks(opts: LifecycleHookBridgeOptions): () => void {
  const { hookRunner, events, cwd, logger } = opts;
  const disposers: Array<() => void> = [];

  const envFor = (sessionId: string | undefined): HookRunEnv =>
    sessionId ? { cwd, session: { id: sessionId } } : { cwd };

  const detached = (label: string, work: Promise<void>): void => {
    void work.catch((err: unknown) => {
      logger?.warn?.(`${label} hook dispatch failed: ${toErrorMessage(err)}`);
    });
  };

  if (opts.compactor?.observe) {
    const triggerOf = (trigger: CompactionTrigger | undefined): CompactionTrigger =>
      trigger ?? 'auto';
    disposers.push(
      opts.compactor.observe({
        before: async (ctx, compactOpts) => {
          if (!hookRunner.has('PreCompact')) return;
          const trigger = triggerOf(compactOpts.trigger);
          await hookRunner.observe(
            'PreCompact',
            { compaction: { trigger, aggressive: compactOpts.aggressive === true } },
            ctx,
            trigger,
          );
        },
        after: async (ctx, compactOpts, report) => {
          if (!hookRunner.has('PostCompact')) return;
          const trigger = triggerOf(compactOpts.trigger);
          await hookRunner.observe(
            'PostCompact',
            {
              compaction: {
                trigger,
                aggressive: compactOpts.aggressive === true,
                tokensBefore: report.before,
                tokensAfter: report.after,
              },
            },
            ctx,
            trigger,
          );
        },
      }),
    );
  }

  disposers.push(
    events.on('delegate.started', (e) => {
      if (!hookRunner.has('SubagentStart')) return;
      detached(
        'SubagentStart',
        hookRunner.observe(
          'SubagentStart',
          {
            subagent: {
              target: e.target,
              task: e.task,
              subagentId: e.subagentId,
              delegationId: e.delegationId,
              mode: e.mode,
            },
          },
          envFor(e.sessionId),
          e.target,
        ),
      );
    }),
  );

  disposers.push(
    events.on('delegate.completed', (e) => {
      if (!hookRunner.has('SubagentStop')) return;
      detached(
        'SubagentStop',
        hookRunner.observe(
          'SubagentStop',
          {
            subagent: {
              target: e.target,
              task: e.task,
              subagentId: e.subagentId,
              delegationId: e.delegationId,
              mode: e.mode,
              ok: e.ok,
              status: e.status,
              summary: e.summary,
              durationMs: e.durationMs,
            },
          },
          envFor(e.sessionId),
          e.target,
        ),
      );
    }),
  );

  disposers.push(
    events.on('tool.confirm_needed', (e) => {
      if (!hookRunner.has('Notification')) return;
      detached(
        'Notification',
        hookRunner.observe(
          'Notification',
          {
            notification: {
              kind: 'permission',
              message: `Permission needed to run ${e.tool.name}`,
              toolName: e.tool.name,
            },
          },
          envFor(e.sessionId),
          'permission',
        ),
      );
    }),
  );

  // Passive: this listener only reports the question and can never answer it,
  // so it must not count as a surface — otherwise a host with no one to ask
  // would leave every clarify form waiting for an answer that cannot come.
  disposers.push(markUserInputObserver());
  disposers.push(
    events.on('user.input_requested', (e) => {
      if (!hookRunner.has('Notification')) return;
      detached(
        'Notification',
        hookRunner.observe(
          'Notification',
          { notification: { kind: 'input', message: e.request.title } },
          envFor(e.sessionId),
          'input',
        ),
      );
    }),
  );

  disposers.push(
    events.on('session.ended', (e) => {
      if (!hookRunner.has('SessionEnd')) return;
      const work = hookRunner
        .observe('SessionEnd', {}, envFor(e.sessionId ?? e.id))
        .catch((err: unknown) => {
          logger?.warn?.(`SessionEnd hook dispatch failed: ${toErrorMessage(err)}`);
        });
      // Join the session-close barrier when the emitter offers one, so a
      // SessionEnd hook (flush a transcript, post a summary) completes first.
      e.waitUntil?.(work);
    }),
  );

  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}
