import { FetchError, ParseError } from '@wrongstack/contracts/types/errors';
import {
  diffRegistry,
  type PromptRegistryManifest,
  type RegistryDiff,
  validateRegistryManifest,
} from '@wrongstack/contracts/types/prompt-registry';

/**
 * Fetch a JSON document. Injectable so the installer is testable without
 * network access. Defaults to the global `fetch`.
 */
export type JsonFetcher = (url: string) => Promise<unknown>;

const defaultFetcher: JsonFetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new FetchError({
      message: `registry fetch failed: ${res.status} ${res.statusText}`,
      status: res.status,
      context: { op: 'fetchManifest' },
    });
  }
  return res.json();
};

export interface PromptPullResult {
  manifest: PromptRegistryManifest;
  diff: RegistryDiff;
  /** Always true for the stub — pull never writes anything yet. */
  dryRun: true;
}

export interface PromptInstallerOptions {
  fetcher?: JsonFetcher | undefined;
}

/**
 * PromptInstaller — registry sync GROUNDWORK (stub).
 *
 * `pull()` fetches and validates a remote manifest and computes the checksum
 * diff against the prompts the caller already has — but writes NOTHING. The
 * actual download/write is the documented extension point (`install`), left
 * unimplemented so the sync surface can land incrementally and be reviewed
 * before it can touch the user's prompt store.
 *
 * Mirrors `SkillInstaller`. For a GitHub-backed hub, the contract is a repo
 * with a top-level `registry.json` (a `PromptRegistryManifest`) plus
 * `prompts/<slug>.json` bodies — the same shape the bundled dataset emits.
 */
export class PromptInstaller {
  private readonly fetcher: JsonFetcher;

  constructor(opts: PromptInstallerOptions = {}) {
    this.fetcher = opts.fetcher ?? defaultFetcher;
  }

  /**
   * Fetch + validate a manifest and report what a sync WOULD change. Read-only.
   * @param manifestUrl URL to the registry's `registry.json`.
   * @param local       The prompts the caller already has (slug + checksum).
   */
  async pull(
    manifestUrl: string,
    local: { slug: string; checksum?: string | undefined }[],
  ): Promise<PromptPullResult> {
    const raw = await this.fetcher(manifestUrl);
    const validated = validateRegistryManifest(raw);
    if (!validated.ok) {
      throw new ParseError({
        message: `Invalid prompt registry manifest:\n  - ${validated.errors.join('\n  - ')}`,
        source: 'prompt-registry-manifest',
      });
    }
    const diff = diffRegistry(local, validated.manifest);
    return { manifest: validated.manifest, diff, dryRun: true };
  }

  /**
   * EXTENSION POINT (not yet wired): download the prompt bodies for the given
   * registry refs and write them into the user layer as `source:'synced'`,
   * recording each in the installed-prompts manifest. Intentionally unimplemented
   * — pulling real content over the network is gated behind a future change so
   * the format/diff path can ship and be reviewed first.
   */
  async install(): Promise<never> {
    throw new Error(
      'Prompt sync is not implemented yet. `pull()` reports the diff; ' +
        'installing remote prompt bodies will land in a follow-up.',
    );
  }
}
