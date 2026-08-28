/**
 * Refresh the `.wrongstack/domain-terms.md` mirror file at CLI boot.
 *
 * Background
 * ----------
 * The Project Jargon Dictionary feature previously split ownership
 * between two storage backends (per `packages/sage/docs/direct-icp-usage.md`):
 *   - SAGE's SQLite store was the authoritative source of truth.
 *   - `.wrongstack/domain-terms.md` was a *derived* view of the same
 *     data, kept on disk so humans (and ProjectRoot sandboxes) could
 *     read the glossary without going through the IPC client.
 *
 * After the domain-term persistence removal, the mirror is the
 * **only** persisted view: the extractor no longer writes per-term
 * SAGE memories, and the file is regenerated from the in-memory
 * `ExtractedTerm[]` of the most recent extraction pass. At boot
 * there is no in-memory state yet, so this helper writes the
 * canonical "no terms detected" placeholder so the path always
 * exists for downstream readers. The per-turn
 * `createSageDomainTermExtractorMiddleware` and the session-end
 * commit extractor overwrite the file with the freshly extracted
 * terms on the next opportunity.
 *
 * `SageDomainTermExtractor.writeDomainTermsFile` already knows how
 * to render the markdown; this module is the runtime host caller
 * for it.
 *
 * Behaviour
 * ---------
 * - **Fire and forget at boot.** The mirror is a derived artefact;
 *   a failure to refresh at startup must not abort the CLI. The
 *   helper logs via `writeErr` and returns `null` on failure.
 * - **Idempotent.** Calling this on every boot is safe: the file is
 *   regenerated atomically by `writeDomainTermsFile`, and the
 *   content is fully derived from the supplied in-memory
 *   `ExtractedTerm[]` (empty at boot).
 * - **Honest about scope.** Only the CLI host invokes this. TUI and
 *   WebUI hosts share the same on-disk path and read the same file;
 *   the CLI boot path is the canonical place to refresh the mirror.
 */
import { writeErr } from '@wrongstack/core/utils';
import { SageDomainTermExtractor } from '@wrongstack/sage';

interface RefreshDomainTermsMirrorOptions {
  /** Absolute project root whose `.wrongstack/domain-terms.md` should be refreshed. */
  projectRoot: string;
}

/**
 * Regenerate the mirror file with the empty placeholder so the path
 * always exists. The next per-turn or session-end extraction pass
 * overwrites the file with the freshly extracted terms.
 *
 * Returns the absolute path of the written file, or `null` when the
 * refresh failed (the CLI logs the underlying reason to stderr and
 * continues).
 *
 * Never throws — callers are guaranteed to receive a `string | null`
 * outcome.
 */
export async function refreshDomainTermsMirror(
  options: RefreshDomainTermsMirrorOptions,
): Promise<string | null> {
  try {
    const extractor = new SageDomainTermExtractor();
    // Empty terms at boot: the placeholder is the canonical "no
    // project-specific terms detected yet" markdown body. The next
    // extraction pass replaces it.
    return await extractor.writeDomainTermsFile(options.projectRoot, []);
  } catch (err) {
    writeErr(
      `[wrongstack] domain-terms mirror refresh failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return null;
  }
}
