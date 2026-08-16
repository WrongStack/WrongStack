/**
 * Subscribe to the CLI's `session.ended` event and run a last-pass
 * extraction over the project's `git log` whenever a session closes.
 *
 * Background
 * ----------
 * Most projects only surface true domain terminology in their commit
 * history — feature names ("Mailbox Bridge"), module names ("Sdd
 * Board Projector"), or internal protocol names that rarely appear in
 * user chat but consistently show up in commit subjects and diff
 * files. The turn-level `createSageDomainTermExtractorMiddleware`
 * catches the chat-side vocabulary; this subscriber catches the
 * commit-side vocabulary at session boundary so the
 * `.wrongstack/domain-terms.md` mirror stays fresh even for users
 * who never talk about their modules in conversation.
 *
 * Memory persistence is now disabled
 * ----------------------------------
 * The extractor no longer writes per-term SAGE memories, so the
 * session-end pass also no longer performs LWW dedup against existing
 * `domain-term`-tagged entries. The pass still runs through
 * `persistViaAndMirror` so the on-disk mirror is regenerated from the
 * commit-derived `ExtractedTerm[]` on every session close.
 *
 * Architectural rule
 * ------------------
 * The subscriber subscribes through the core `EventBus` rather than
 * reaching into CLI internals, so any host that wires
 * `subscribeSessionEndCommitExtractor(events, options)`
 * (CLI, TUI, WebUI, or a custom embedder) gets the same last-pass
 * commit-mining behaviour. The CLI's `setupSage` wires this helper
 * internally; TUI and WebUI hosts must call it explicitly during
 * their own runtime setup so the rule that **Jargon Dictionary
 * updates are derived state, not session-bound** holds across every
 * host surface.
 *
 * Event lifecycle and the `waitUntil` contract
 * --------------------------------------------
 * `session.ended` is emitted synchronously by the CLI's
 * `execution-cleanup.ts`, but the emitter hands every listener a
 * `waitUntil(work: Promise<void>)` hook. The cleanup loop
 * (`sessionEndProducers` Set) tracks each registered promise and
 * only proceeds to close the SAGE writer / session file once every
 * tracked producer has settled. We register our extraction work
 * through that hook so:
 *
 *   1. The CLI doesn't tear down the SQLite writer mid-write.
 *   2. A long `git log -p` scan doesn't block the synchronous
 *      cleanup path — the listener returns immediately and the
 *      extraction runs on the microtask queue.
 *   3. If the user closes a session while an unrelated review /
 *      cascade work is in flight, our extraction joins the same
 *      tracked-producer set and gets the same join treatment.
 *
 * If `payload.waitUntil` is absent (older host or test emit), we
 * fall back to `void run().catch(...)` — the work still runs, just
 * outside the join contract. The extraction itself is advisory.
 */
import type { EventBus } from '@wrongstack/core/kernel';
import type { MemoryPort } from '@wrongstack/core/types';
import { writeErr } from '@wrongstack/core/utils';
import { SageDomainTermExtractor } from '../domain-term-extractor.js';

export interface SubscribeSessionEndCommitExtractorOptions {
  /**
   * Resolved SAGE `MemoryPort`. With persistence disabled the port
   * is no longer used for write-back; it is kept on the option shape
   * so existing call sites (and the SAGE-only architectural rule
   * that this subscriber runs only when a SAGE port is present)
   * keep working unchanged. When omitted the subscription is a
   * pure no-op — `session.ended` is still observed but the commit
   * scan is skipped.
   */
  memory?: MemoryPort | undefined;
  /**
   * Absolute project root whose `git log` will be scanned. Required —
   * without it the extractor has no `git -C` target.
   */
  projectRoot: string;
  /**
   * Bounded number of commits to scan per session end. Defaults to 32
   * (last-day-equivalent for most active repos). Higher values cost
   * extra shell-out time per session close.
   */
  maxCommits?: number;
  /**
   * Bounded number of terms kept per extraction pass. Defaults to 8
   * (the dictionary block already caps at 12; running higher just
   * pays the merge cost for terms that will be hidden anyway).
   */
  limit?: number;
  /**
   * Override the extractor instance used for this subscription. Useful
   * for tests; production callers should leave this undefined and
   * accept the default `new SageDomainTermExtractor()` factory.
   */
  createExtractor?: () => SageDomainTermExtractor;
}

/**
 * Subscribe the commit-side extractor to the `session.ended` event.
 *
 * Returns the unsubscribe disposer from `EventBus.on` so callers can
 * wire it into their own teardown. The disposer is a no-op after the
 * first call; subscribers are guaranteed to be detached before the
 * EventBus listener-count cap could be reached by repeated
 * subscribe/unsubscribe cycles.
 *
 * Never throws.
 */
export function subscribeSessionEndCommitExtractor(
  events: EventBus,
  options: SubscribeSessionEndCommitExtractorOptions,
): () => void {
  const unsubscribe = events.on('session.ended', (payload) => {
    const work = extractFromProjectCommits(options)
      .catch((err) => {
        writeErr(
          `[wrongstack] session-end commit extraction failed: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      })
      .finally(() => undefined);
    const waitUntil = (payload as { waitUntil?: unknown }).waitUntil;
    if (typeof waitUntil === 'function') {
      (waitUntil as (work: Promise<void>) => void)(work);
      return;
    }
    // Host didn't supply a join hook — fire and forget. Extraction
    // is advisory; missing it must not crash the session.
    void work;
  });
  return unsubscribe;
}

async function extractFromProjectCommits(
  options: SubscribeSessionEndCommitExtractorOptions,
): Promise<void> {
  if (!options.memory) return;
  const createExtractor = options.createExtractor ?? (() => new SageDomainTermExtractor());
  const extractor = createExtractor();
  const terms = await extractor.extractFromCommits({
    projectRoot: options.projectRoot,
    maxCommits: options.maxCommits ?? 32,
    limit: options.limit ?? 8,
  });
  if (terms.length === 0) return;
  // `persistViaAndMirror` is a no-op for memory writes (see
  // `domain-term-extractor.ts`) and regenerates
  // `<projectRoot>/.wrongstack/domain-terms.md` from the in-memory
  // terms. Refreshing the mirror here keeps the on-disk view aligned
  // with the latest commit-derived vocabulary on every session close
  // without an extra write call.
  await extractor.persistViaAndMirror(options.memory, terms, {
    projectRoot: options.projectRoot,
  });
}
