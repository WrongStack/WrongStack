import {
  type ChronicleSessionWiring,
  type ChronicleSessionWiringOptions,
  wireChronicleSession,
} from '@wrongstack/chronicle';
import type { EventBus } from '@wrongstack/contracts/kernel';
import { resolveWstackPaths, toErrorMessage } from '@wrongstack/core/utils';
import type { WebUIOptions } from './types.js';

export interface StandaloneChronicleInput {
  opts: Pick<WebUIOptions, 'services'>;
  /** The bus every tab's agent emits on. */
  events: EventBus;
  config: object;
  projectRoot: string;
  wpaths: ChronicleSessionWiringOptions['paths'];
  /** The leader tab, for events that carry no session of their own. */
  getSessionId: () => string;
  logger: { warn: (message: string, meta?: Record<string, unknown>) => void };
  /** Test seam; production uses the shared Chronicle producer. */
  wire?: typeof wireChronicleSession;
}

/** The standalone host's Chronicle producer, following the host across project switches. */
export interface StandaloneChronicle {
  /** Records from now on into `projectRoot`'s Chronicle (after `projects.select`). */
  switchProject(projectRoot: string): void;
  /** Unsubscribes the producers and closes every journal this host opened. */
  dispose(): Promise<void>;
}

/**
 * Records the standalone host's conversations in the project Chronicle, through
 * the producer path the CLI host uses. The desktop engine is this host: before
 * this, nothing here wrote to Chronicle, so a desktop conversation's Session
 * Story queried a history with no context, model, tool or file events in it.
 *
 * A caller that hands `startWebUI` its own EventBus (`opts.services.events`)
 * already owns that bus's producers; wiring it again would record every event
 * twice.
 */
export function wireStandaloneChronicle(
  input: StandaloneChronicleInput,
): StandaloneChronicle | undefined {
  if (input.opts.services?.events) return undefined;
  const wire = input.wire ?? wireChronicleSession;
  let reported = false;
  const open = (projectRoot: string, paths: ChronicleSessionWiringOptions['paths']) =>
    wire({
      events: input.events,
      config: input.config as Record<string, unknown>,
      projectRoot,
      paths,
      sessionId: input.getSessionId,
      // One warning per host: a journal that refuses appends would refuse them all.
      onPersistError: (error) => {
        if (reported) return;
        reported = true;
        input.logger.warn('chronicle: an event could not be recorded', {
          message: toErrorMessage(error),
        });
      },
    });
  let root = input.projectRoot;
  let current: ChronicleSessionWiring | undefined = open(root, input.wpaths);
  const closing: Promise<void>[] = [];
  return {
    switchProject(projectRoot) {
      if (projectRoot === root) return;
      // The old producers unsubscribe synchronously, before the new ones subscribe, so no
      // event lands in both projects; the old journal drains in the background.
      if (current) closing.push(current.dispose().catch(() => undefined));
      root = projectRoot;
      const paths = resolveWstackPaths({ projectRoot, globalRoot: input.wpaths.globalRoot });
      current = open(projectRoot, paths);
    },
    async dispose() {
      const last = current;
      current = undefined;
      await Promise.all([...closing, last?.dispose()]);
    },
  };
}
