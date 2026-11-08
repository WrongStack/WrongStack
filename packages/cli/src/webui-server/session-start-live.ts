/** The CLI host's `session.start` payload builder, bound to the live options and per-tab agents. */

import type { SessionAgentRegistry } from '@wrongstack/webui-server';
import {
  type BuildSessionStartPayload,
  createSessionStartPayloadBuilder,
  type SessionStartPayloadDeps,
} from './session-start-payload.js';

/**
 * The host's builder, reading the live `opts` and the per-tab agent registry.
 * `getSessionAgents` is a forward reference: the registry is built after the
 * builder, so a payload for a background tab still reports that tab's model,
 * mode and context window rather than the leader's.
 */
export function createLiveSessionStartPayloadBuilder<T extends SessionStartPayloadDeps>(
  opts: T,
  getSessionAgents: () => SessionAgentRegistry | undefined,
  hostCapabilities?: readonly string[],
): BuildSessionStartPayload {
  return createSessionStartPayloadBuilder({
    ...opts,
    ...(hostCapabilities ? { hostCapabilities } : {}),
    // Read through to the live `opts`, do NOT snapshot: `projects.select`
    // re-roots the host by assigning `opts.projectRoot` / `opts.session` on
    // this very object. A spread copy froze both at boot, so every
    // `session.start` broadcast after a project switch still announced the
    // previous project's root — the switch looked like it had not happened.
    get projectRoot() {
      return opts.projectRoot;
    },
    get session() {
      return opts.session;
    },
    get appConfig() {
      return opts.appConfig;
    },
    // `peek`, never `get`: building a payload must not materialise an agent
    // for a session id that arrived from a stale browser tab.
    getSessionContext: (sessionId) => getSessionAgents()?.peek(sessionId)?.ctx,
  });
}
