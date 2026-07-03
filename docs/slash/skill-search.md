# /skill-search

Search the skill registry (skills.sh by default) for installable agent skills.

## Usage

```
/skill-search <query> [--page N] [--pageSize N]
```

Searches the configured skill registry for skills matching `<query>`, renders a
list with each hit's name, author, install count, security score, and the
`/skill-install` ref to install it.

## Examples

```
/skill-search react
/skill-search "code review"
/skill-search docker --page 2
```

## Output

Each hit shows:

- **name** and **author** (the GitHub owner)
- a security-score glyph: `✓<score>` for medium/high (≥30), `⚠<score>` for low (<30)
- install count (when the registry reports it)
- a one-line description (truncated)
- the `→ /skill-install <owner/repo>` ref to install it

Results are grouped by registry adapter. Duplicate install refs (the same GitHub
repo listed by two registries) are deduplicated — the first adapter in the
configured order wins.

## Installing a hit

Copy the `→ /skill-install ...` line. The install ref is a plain `user/repo`
(or `user/repo@ref`), so:

```
/skill-install octocat/react-pro
/skill-install octocat/react-pro@v2.0.0
```

## Registries

The default registry is **skills.sh** (the open agent-skills marketplace backed
by [mastra-ai/skills-api](https://github.com/mastra-ai/skills-api), indexing
34k+ skills from 2.8k+ repos). The GitHub-direct adapter is always present as
the fallback install path but does not contribute search results.

Point at a self-hosted skills-api instance via `config.skills.registryUrl`
(in `~/.wrongstack/config.json` — **not** the repo-committed `.wrongstack/config.json`,
which is stripped because the parsed response flows into the prompt):

```json
{
  "skills": { "registryUrl": "https://skills.internal.company.com" }
}
```

## Private GitHub repos

When installing a hit that resolves to a private repo, set `GITHUB_TOKEN`
(or `GH_TOKEN`) in your environment. Without a token only public repos work,
and the anonymous GitHub API rate limit (60/hour) applies. See `/skill-install`.

## Related

- `/skill-install` — install a skill from a ref
- `/skill` — list or view installed skills
- `/skill-gen` — create new skills
- [docs/skills.md](../skills.md) — the full skill authoring guide
