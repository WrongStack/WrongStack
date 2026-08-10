/**
 * Refresh the `.wrongstack/domain-terms.md` mirror file from the
 * resolved SAGE `MemoryPort` at CLI boot.
 *
 * Background
 * ----------
 * The Project Jargon Dictionary feature splits ownership between two
 * storage backends (per `packages/sage/docs/direct-icp-usage.md`):
 *   - SAGE's SQLite store is the authoritative source of truth.
 *   - `.wrongstack/domain-terms.md` is a *derived* view of the same
 *     data, kept on disk so humans (and ProjectRoot sandboxes) can
 *     read the glossary without going through the IPC client.
 *
 * `SageDomainTermExtractor.writeDomainTermsFile` already knows how to
 * regenerate the file from the canonical SAGE state. What it lacks
 * is a runtime host caller — the helper exists only in tests. This
 * module closes that gap for the CLI host.
 *
 * Behaviour
 * ---------
 * - **Fire and forget at boot.** The mirror is a derived artefact;
 *   a failure to refresh at startup must not abort the CLI. The
 *   helper logs via `writeErr` and returns `null` on failure.
 * - **Idempotent.** Calling this on every boot is safe: the file is
 *   regenerated atomically by `writeDomainTermsFile`, and the content
 *   is fully derived from SAGE state.
 * - **Honest about scope.** Only the CLI host invokes this. TUI and
 *   WebUI hosts share the same SAGE port and read the same file; the
 *   CLI boot path is the canonical place to refresh the mirror.
 */
import type { MemoryPort } from '@wrongstack/core/types';
import { writeErr } from '@wrongstack/core/utils';
import { SageDomainTermExtractor } from '@wrongstack/sage';

export interface RefreshDomainTermsMirrorOptions {
  /** Absolute project root whose `.wrongstack/domain-terms.md` should be refreshed. */
  projectRoot: string;
  /**
   * Resolved SAGE `MemoryPort`. The extractor reads the `domain-term`
   * tagged subset from this port.
   */
  memoryStore: MemoryPort;
}

/**
 * Regenerate the mirror file from the current SAGE state.
 *
 * Returns the absolute path of the written file, or `null` when the
 * refresh failed (the CLI logs the underlying reason to stderr and
 * continues — the SAGE corpus remains authoritative).
 *
 * Never throws — callers are guaranteed to receive a `string | null`
 * outcome.
 */
export async function refreshDomainTermsMirror(
  options: RefreshDomainTermsMirrorOptions,
): Promise<string | null> {
  try {
    const extractor = new SageDomainTermExtractor();
    return await extractor.writeDomainTermsFile(options.projectRoot, options.memoryStore);
  } catch (err) {
    writeErr(
      `[wrongstack] domain-terms mirror refresh failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return null;
  }
}
