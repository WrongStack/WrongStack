# /sync - GitHub-Backed Cloud Sync

Registered by the built-in `wstack-sync` plugin. Syncs selected WrongStack user
data categories to a GitHub repository using a personal access token.

## Usage

| Command | Effect |
|---|---|
| `/sync` | Show sync status |
| `/sync status` | Same as `/sync` |
| `/sync enable owner/repo TOKEN [cat1 cat2 ...]` | Enable sync for a GitHub repository |
| `/sync disable` | Disable sync while keeping local data |
| `/sync push` | Upload selected categories |
| `/sync pull` | Download selected categories |
| `/sync categories list` | Show selected and available categories |
| `/sync categories add <name>` | Add a category to the sync set |
| `/sync categories remove <name>` | Remove a category from the sync set |

Without explicit categories, `/sync enable` enables all categories from
`ALL_SYNC_CATEGORIES`.

The GitHub token is encrypted and written to `~/.wrongstack/profiles/<name>/sync.json` via
`atomicWrite`; `/sync enable` refuses to persist a new token when secure vault storage is unavailable.
The in-memory token stays decrypted for GitHub API calls.

The target repository must contain at least one commit (for example, initialize it with a README).
`/sync push` can create a missing `main` branch when Git objects already exist, but GitHub's Git
Data API cannot create the first commit in a completely empty repository.

## Code Reference

- `packages/core/src/plugins/sync-plugin.ts`
- `packages/core/src/storage/cloud-sync.ts`
- `packages/core/src/types/config.ts`
