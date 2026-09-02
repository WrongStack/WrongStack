/**
 * SessionRegistry + AgentStatusTracker + FleetNotifier wiring.
 *
 * Extracted from cli-main.ts to make the inline block unit-testable.
 * Registers the current session in the cross-process registry, starts the
 * agent status tracker, and installs a graceful shutdown handler that
 * marks the session as closing and disposes the tracker + notifier.
 *
 * Every operation is wrapped in try/catch — failures degrade gracefully
 * (tracker remains undefined and downstream code treats that as absent).
 */
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import type { EventBus } from '@wrongstack/core/kernel';
import { createGracefulShutdown } from '../shutdown-cleanup.js';

interface SetupSessionRegistryDeps {
  wpaths: {
    globalRoot: string;
    projectDir: string;
    projectSlug: string;
  };
  projectRoot: string;
  session: { id: string };
  context: { workingDir: string; session: { id: string } };
  tuiOwnsScreen: boolean;
  events: EventBus;
}

interface SetupSessionRegistryResult {
  /** AgentStatusTracker when the dynamic import and setup succeeded, else undefined. */
  tracker:
    | InstanceType<typeof import('@wrongstack/core/coordination').AgentStatusTracker>
    | undefined;
  /**
   * Atomically move this process's registry ownership to another session.
   * Used by explicit resume; unrelated sessions in other processes are untouched.
   */
  activateSession: (sessionId: string, target?: SessionIdentityTarget) => Promise<void>;
}

export interface SessionIdentityTarget {
  projectSlug: string;
  projectRoot: string;
  projectName: string;
  workingDir: string;
  gitBranch?: string | undefined;
}

export async function setupSessionRegistry(
  deps: SetupSessionRegistryDeps,
): Promise<SetupSessionRegistryResult> {
  const { wpaths, projectRoot, session, context, tuiOwnsScreen, events } = deps;

  // biome-ignore lint/suspicious/noExplicitAny: AgentStatusTracker type from dynamic import
  let tracker: any | undefined;
  let activateSession = async (
    _sessionId: string,
    _target?: SessionIdentityTarget,
  ): Promise<void> => {};
  let ownershipEstablished = false;

  try {
    const [{ getSessionRegistry }, { AgentStatusTracker, FleetNotifier }] = await Promise.all([
      import('@wrongstack/core/storage'),
      import('@wrongstack/core/coordination'),
    ]);
    const registry = getSessionRegistry(wpaths.globalRoot);
    const projectSlug = path.basename(wpaths.projectDir);
    const projectName = path.basename(projectRoot);

    // Detect current git branch (best-effort, non-blocking)
    let gitBranch = await new Promise<string | undefined>((resolve) => {
      execFile(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        {
          cwd: projectRoot,
          encoding: 'utf8',
          timeout: 3000,
          windowsHide: true,
          maxBuffer: 64 * 1024,
        },
        (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined),
      );
    });
    if (gitBranch === 'HEAD') gitBranch = undefined; // detached HEAD

    await registry.register({
      sessionId: session.id,
      projectSlug,
      projectRoot,
      projectName,
      workingDir: context.workingDir,
      gitBranch,
      // The TUI and the REPL both boot through cli-main; `tuiOwnsScreen`
      // distinguishes the surface so the Fleet HQ map can label this session.
      clientType: tuiOwnsScreen ? 'tui' : 'cli',
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    ownershipEstablished = true;
    let currentIdentity: SessionIdentityTarget = {
      projectSlug,
      projectRoot,
      projectName,
      workingDir: context.workingDir,
      gitBranch,
    };
    // Ownership cleanup is correctness-critical and must not depend on
    // optional tracker/notifier construction succeeding.
    // biome-ignore lint/suspicious/noExplicitAny: FleetNotifier type from dynamic import
    let fleetNotifier: any | undefined;
    activateSession = async (sessionId: string, target?: SessionIdentityTarget): Promise<void> => {
      const nextIdentity = target ?? currentIdentity;
      await registry.register({
        sessionId,
        ...nextIdentity,
        clientType: tuiOwnsScreen ? 'tui' : 'cli',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        agents: tracker?.getAgents?.() ?? [],
      });
      currentIdentity = nextIdentity;
      fleetNotifier?.setProjectRoot(nextIdentity.projectRoot);
      fleetNotifier?.notify();
    };

    // Graceful shutdown. `registry.markClosing()` is an awaited atomic disk
    // write; calling `process.exit(0)` immediately after `void cleanup()` cut
    // the write off and left the cross-process registry thinking the host was
    // still alive after Ctrl+C. `createGracefulShutdown` matches the
    // established pattern in webui-server/lifecycle.ts + cli-entry-point.ts:
    // await the cleanup, set `exitCode`, give Node a 500ms grace to drain,
    // then force exit. A second signal short-circuits to immediate exit.
    createGracefulShutdown({
      run: async () => {
        try {
          fleetNotifier?.dispose();
        } catch {
          /* best effort */
        }
        await registry.markClosing().catch(() => undefined);
        try {
          tracker?.stop();
        } catch {
          /* best effort */
        }
        // Clean exits should disappear immediately. Generation-aware
        // unregister protects a replacement owner if shutdown raced with a
        // session transition; dead/crashed processes remain covered by prune.
        await registry.unregister().catch(() => undefined);
      },
    }).install();

    // Push-on-write: nudge same-project WebUIs the instant our agents advance,
    // so the Fleet HQ map reflects this TUI/REPL in ~ms (not watch/poll lag).
    try {
      fleetNotifier = new FleetNotifier({
        baseDir: wpaths.globalRoot,
        projectRoot,
        selfPid: process.pid,
      });
      tracker = new AgentStatusTracker({
        events,
        registry,
        sessionId: () => context.session.id,
        onUpdate: () => fleetNotifier?.notify(),
      });
      tracker.start();
    } catch {
      // Optional live-agent telemetry must not disable session ownership,
      // activation, or its clean-shutdown unregister path.
      tracker = undefined;
    }
  } catch (err) {
    // Ownership is a correctness boundary: a host that could not publish its
    // claim must not continue and let another process open the same session.
    if (!ownershipEstablished) throw err;
    // Agent telemetry remains optional after ownership has been established.
  }

  return { tracker, activateSession };
}
