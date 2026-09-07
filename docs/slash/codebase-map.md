# /codebase-map — Ranked repository map and the Atlas projection

## What it does

Shows the codebase index's view of the repository, ranked by **graph
centrality** rather than by filename, and publishes that view as a committable
projection called the **Atlas**.

Ranking is PageRank over the index's reference graph — calls, imports, type
references, `inherit` and `implement` edges. A file is central because the rest
of the codebase depends on it, not because it happens to be called `index.ts`.
Scores are normalised so the most central file in the repository is `1.0000`,
and they are meaningful **only within one repository**.

## Usage

| Usage | Output |
|---|---|
| `/codebase-map` | Print the ranked map: package clusters with their hub file, repository-wide hotspots, then the signatures of the most central files. |
| `/codebase-map --tokens 2000` | The same, with a larger token budget (default ~1200). |
| `/codebase-map --write` | Write the Atlas into `.wrongstack/atlas/`. |
| `/codebase-map --check` | Report whether a previously written Atlas still matches the index. |
| `/codebase-map --enrich` | Summarise files with a model — build the concept layer. |
| `/codebase-map --enrich --max-files 50` | The same, stopping after 50 files, to sample the cost. |
| `/codebase-map --embed` | Build semantic vectors from those summaries. |
| `/codebase-map --export` | Write a standalone HTML map to `atlas.html`. |
| `/codebase-map --export docs/map.html` | The same, to a path you choose (directories are created). |

Alias: `/atlas`.

Run `/codebase-reindex` first if the project has never been indexed — the map
falls back to a filename heuristic without an index, and the Atlas commands
refuse to run rather than creating an empty database.

## The Atlas

The index itself is a SQLite database under `~/.wrongstack/projects/`. On this
repository it is around 180 MB: machine-local, binary, and unreviewable. Every
fresh clone, every CI run and every teammate therefore starts cold, and nobody
can see in a pull request what the index believes about the code.

`--write` projects that database into three small files in the repository:

| File | Contents |
|---|---|
| `.wrongstack/atlas/atlas.json` | Structured: counts, packages with their hub and rank, and the most central files with their declarations. |
| `.wrongstack/atlas/ATLAS.md` | A human-sized overview: every package with its hub, and the head of the ranking. The complete list stays in `atlas.json`. |
| `.wrongstack/atlas/manifest.json` | Per-file content hashes plus a repository-wide digest, used by `--check`. |

The database stays canonical; this is strictly a one-way projection.

### Determinism

Regenerating the Atlas from an unchanged index produces **byte-identical**
files. There are no timestamps and no absolute paths, keys are emitted in
sorted order, ranks are rounded to four decimals, and line endings are LF.

This is a hard requirement rather than a nicety: anything that varied per run
would turn every indexing run into a merge conflict.

### Drift

A committed Atlas that describes code which has since moved is worse than no
Atlas, because it is confidently wrong. `--check` compares the recorded content
hashes against the live index and reports exactly what drifted:

```
⚠ atlas has drifted from the index
  changed (2):
    packages/core/src/types/provider.ts
    packages/core/src/core/context.ts
  run /codebase-map --write to refresh
```

The manifest's repository-wide digest also catches changes to files the Atlas
does not itself carry — in that case `--check` reports drift without naming a
file, because the change is outside the projected set.

## The concept layer

The structural index knows what is *declared*. It cannot answer "where do we
back off after a 429", because no symbol is called that. The concept layer
fills that gap: one short plain-English description per file of what the file
is **for**, plus a **crux** — the line span that actually carries its meaning.
A summary can drift from the truth; a pointer into the source cannot, so the
two are always stored together.

This is the only part of indexing that spends money, so it is off until you
enable it:

```yaml
indexing:
  concepts:
    enabled: true
    # model: deepseek-chat   # optional; otherwise the cheapest configured tier
    # concurrency: 5
    # subsystems: true
```

Then `/codebase-map --enrich`. Cost is one model call per file on the first
pass and, after that, only the files whose bytes changed — `files.content_hash`
is the cache key. Start with `--max-files 50` to measure the real cost on your
repository before committing to a full pass.

The pass is interruptible and resumable: every summary is written as it
arrives, so a cancelled run keeps everything it already paid for. A model that
refuses, times out, or answers unparseably costs that one file its summary and
nothing else — the failure is reported and the walk continues.

Files are visited most-central-first, so a budget that runs out runs out on the
files fewest people ever open. Every indexed file is a candidate, including the
ones the reference graph never reaches.

With `subsystems` enabled, a second pass derives one description per package
from the file summaries already stored, plus typed relations between packages
drawn from a closed vocabulary (`uses`, `configures`, `validates`, `extends`,
`persists`, `observes`). Relations to packages that were not derived, and verbs
outside the vocabulary, are dropped rather than stored as dangling edges.

## Semantic search

With the concept layer in place, `--embed` turns each file's description into a
vector. That is what lets `codebase-context` answer a question phrased in the
problem's vocabulary — "where do we back off after a 429" — and reach code
whose identifiers never use those words.

The embedding is **per file, over the summary**, not per symbol over the
signature. A bare declaration carries almost nothing an index does not already
have, and BM25 over FTS5 already matches it better; what carries meaning is the
description of what the file is for. It is also eight times cheaper: eight
thousand files against sixty-six thousand symbols.

```yaml
indexing:
  embeddings:
    enabled: true
    # model: Xenova/all-MiniLM-L6-v2   # must emit 384-dim vectors
    # batchSize: 16
```

This needs the optional `@huggingface/transformers` runtime and downloads a
model on first use. Without it — or with `enabled: false` — retrieval stays
lexical, which is what shipped before. Run `--enrich` first: a vector built
from declaration names instead of a summary is a much weaker signal, and
`--embed` reports how many files it had to fall back on.

Two vectors from different models are not comparable, so changing the model
wipes the table and re-embeds rather than silently mixing two spaces.

Semantic hits do not replace lexical ones — they join them as additional
restart mass in the same graph walk, weighted well under the lexical side
because an exact name match is stronger evidence than a paraphrase.

## The static export

`--export` renders one self-contained HTML file: the package map as an SVG,
the ranked file table, and the subsystem summaries when the concept layer has
run. Clicking a package filters the table.

It embeds its data rather than fetching `atlas.json` beside it, because a page
opened from `file://` cannot fetch a sibling — that request is cross-origin to
a null origin. Double-clicking the file is meant to work, with no server and
no network.

Layout is computed at generation time, not by a simulation in the page, so the
same index always renders the same bytes. That makes the export diffable and
safe to attach to a pull request or publish as a CI artifact.

## The session brief

At session start the Atlas contributes a short block to the system prompt —
the counts, the package clusters with their hub files, the most central files,
and the subsystem one-liners when the concept layer has run. On this
repository it is about 550 tokens.

The point is to stop paying for orientation every session. Without it, a task
in an unfamiliar area begins with several searches that rediscover facts the
index has known since it was built.

It is bounded and fail-open:

- Sections are dropped from the bottom when the budget is tight, so the
  structure survives and the prose is what gets cut.
- If the rank pass has not run, the block is **empty**. It will not fall back
  to a filename heuristic — a guess presented as the repository's structure is
  the failure this whole subsystem exists to remove.
- If the written Atlas has drifted, the block says so out loud. A brief that
  describes code which has since changed is worse than no brief, because the
  reader cannot tell.
- No index, a slow read, or any error contributes nothing at all. Orientation
  must never be the reason a session cannot start.
- Subagents do not get it: their scope comes from their assignment, and the
  leader has already paid for the block.

The block is tagged as a prompt *contributor*, which places it in the
live-context tail rather than the cached system prefix — so it does not
invalidate the prompt cache the way editing the system prompt would.

Configure it under `indexing.atlas`:

```jsonc
{
  "indexing": {
    "atlas": {
      "injectOnSessionStart": true,  // default
      "briefMaxTokens": 800          // default
    }
  }
}
```

## Why the Atlas is not indexed

`.wrongstack/atlas/` is excluded from indexing. It is derived *from* the index,
so indexing it would make the index describe its own output: every `--write`
changes three files, the next index run picks them up, and the freshness check
then reports drift caused by nothing but writing the Atlas.

## Related

- `/codebase-reindex` — build or refresh the index the map reads from.
- `codebase-repo-map` — the same map as a tool the agent can call.
- `codebase-context` — ranked retrieval for a specific task, rather than a
  whole-repository overview.
