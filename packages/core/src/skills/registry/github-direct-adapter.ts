/**
 * GitHub-direct registry adapter.
 *
 * This is the original pre-registry install path wrapped in the adapter
 * interface: the user types `user/repo[@ref]` directly. It does NOT search
 * (GitHub code search is a separate API with its own auth/rate-limit story and
 * isn't a skill catalog), so `search()` returns an empty result. Its job is
 * solely to make `user/repo` flow through the same `<adapterId>:<registryId>`
 * resolution as the skills.sh adapter — except here the "registry id" IS the
 * install ref already.
 *
 * Registered as the fallback adapter so `/skill-install user/repo` keeps
 * working unchanged when no `<adapterId>:` prefix is given.
 */
import type {
  RegistrySearchOptions,
  RegistrySearchResult,
  SkillRegistryAdapter,
} from './registry-adapter.js';

export const githubDirectAdapter: SkillRegistryAdapter = {
  id: 'github',
  displayName: 'GitHub (direct)',

  async search(_query: string, _opts: RegistrySearchOptions = {}): Promise<RegistrySearchResult> {
    // GitHub direct is not a searchable catalog. Returning empty keeps the
    // unified `/skill-search` UX (it just shows results from other adapters).
    return { adapterId: 'github', results: [], hasMore: false };
  },

  resolveInstallRef(registryId: string): string {
    // For the direct adapter the registry id is already the install ref.
    // Light validation: must contain a slash (owner/repo). Full parsing is done
    // by `parseSkillRef` downstream.
    const trimmed = registryId.trim();
    if (!trimmed.includes('/')) {
      // Defer to parseSkillRef for the structured error message.
      return trimmed;
    }
    return trimmed;
  },
};
