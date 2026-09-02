import { hashRequest } from './hash.js';
import type { ReplayLogStore } from '../storage/replay-log-store.js';
import type { ProviderRunner, RunProviderOptions } from '../types/provider-runner.js';
import type { Response } from '../types/provider.js';

/**
 * ReplayProviderRunner — idea #2 from IDEAS.md.
 *
 * A drop-in `ProviderRunner` that wraps an inner runner and either
 *   - records every (request, response) pair it observes (mode: 'record'),
 *   - serves a recorded response when the request hash matches (mode: 'replay'),
 *   - or does both: serve when present, record when not (mode: 'auto').
 *
 * Bind to `TOKENS.ProviderRunner` to completely replace the default
 * runner. Or use `AgentExtension.wrapProviderRunner` to chain in
 * alongside other extensions.
 *
 * Mode semantics:
 *   - 'record' is the production mode. Every real API call is
 *     persisted; the user can later `wstack replay <sessionId>` to
 *     re-run with frozen responses.
 *   - 'replay' is the debugging mode. The agent loop runs normally
 *     (same permissions, same tool dispatch) but every LLM call
 *     comes from the recorded log. If a request hash is not in the
 *     log, we throw — the user is expected to either rebuild the
 *     session or fall back to record mode.
 *   - 'auto' is the warm-start mode for development. The first time
 *     a particular request is seen, it's recorded; the next time
 *     the same request is made, the recorded response is served.
 *     This is the cheapest path to a deterministic test harness.
 *
 * ## What a hit requires
 *
 * The lookup key is `hashRequest`, which covers everything the provider is
 * actually sent — including `system`. The agent loop carries a live-context
 * tail on every request (the continuity ledger, the live next-steps gate,
 * memory evidence, epoch-volatile prompt blocks — appended after the last
 * message; see `agent-response.ts`), and those blocks describe the state of
 * *this* run. A re-run whose ledger or retrieved memory
 * differs therefore produces a different request, and correctly misses: the
 * recorded response answered a different prompt.
 *
 * So `mode: 'replay'` reproduces a run faithfully only when the loop is driven
 * back through the same states — which is what a test harness does, and what a
 * fresh interactive session does not. In an interactive session, prefer
 * `'record'` (build the log) and use `'replay'` from a harness that pins the
 * volatile inputs. `hashRequest` itself is stable across time: local message
 * bookkeeping (`ts`, `_estTokens`, `origin`) is stripped before hashing.
 */
export type ReplayMode = 'record' | 'replay' | 'auto';

export interface ReplayProviderRunnerOptions {
  log: ReplayLogStore;
  /**
   * Which session's log to read and write.
   *
   * Accepts a resolver because recording is wired before the session exists:
   * the boot path binds this runner while the session writer is still being
   * created, and the user may then swap sessions (`/resume`, new session)
   * without the runner being rebuilt. A frozen string there meant the log was
   * filed under a synthetic id with no session behind it. A resolver keeps the
   * log next to the transcript it belongs to, for the session that is actually
   * live at the time of the call.
   */
  sessionId: string | (() => string);
  mode: ReplayMode;
  /**
   * Optional logger — receives a debug line on every replay hit
   * ("served cached response for hash sha256:…") and a warn on
   * every miss in 'replay' mode (the throw that follows is the
   * real signal, but the warn helps when the throw is caught
   * upstream).
   */
  logger?:
    | {
        debug?: ((msg: string) => void) | undefined;
        warn?: ((msg: string) => void) | undefined;
      }
    | undefined;
}

export class ReplayProviderRunner implements ProviderRunner {
  constructor(
    private readonly inner: ProviderRunner,
    private readonly opts: ReplayProviderRunnerOptions,
  ) {}

  /** Resolve the target session for this call. See {@link ReplayProviderRunnerOptions.sessionId}. */
  private resolveSessionId(): string {
    const { sessionId } = this.opts;
    return typeof sessionId === 'function' ? sessionId() : sessionId;
  }

  async run(runOpts: RunProviderOptions): Promise<Response> {
    const hash = hashRequest(runOpts.request);
    // Resolved once per call so a session swap mid-run cannot split a lookup
    // and its record across two logs.
    const sessionId = this.resolveSessionId();
    const cached = await this.opts.log.lookup(sessionId, hash);

    if (this.opts.mode === 'replay') {
      if (!cached) {
        this.opts.logger?.warn?.(
          `replay: no recorded response for hash ${hash} (model ${runOpts.request.model})`,
        );
        throw new Error(
          `ReplayProviderRunner: no recorded response for hash ${hash} in session ${sessionId}. ` +
            `Either the request changed since recording, or this session has no replay log.`,
        );
      }
      this.opts.logger?.debug?.(
        `replay: served cached response for hash ${hash} (recorded ${cached.ts})`,
      );
      return cached.response;
    }

    if (this.opts.mode === 'auto' && cached) {
      this.opts.logger?.debug?.(`replay: auto-hit hash ${hash}, served cached response`);
      return cached.response;
    }

    // 'record' or 'auto' with no cache hit — delegate to the inner runner.
    const response = await this.inner.run(runOpts);
    await this.opts.log.record({
      sessionId,
      request: runOpts.request,
      response,
    });
    return response;
  }
}
