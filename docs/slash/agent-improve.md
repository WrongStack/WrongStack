# /agent-improve — Project agent identity and learning management

Manage per-role project customizations: identity, learned knowledge, runtime
configuration, and the consolidation review process.

Each built-in roster agent has a base definition (role + prompt + tools) in
the catalog. On top of that, each project can override prompt, tools, budget,
attach a custom identity, accumulate learned directives, and distil those
directives into **project addenda for the role's own skills**.

Files live under `.wrongstack/agents/<role>/`:

| File | Purpose |
|---|---|
| `config.json` | Static overrides (tools, budget, model policy, availability) |
| `identity.md` | Custom prompt appendix (tone, project-specific rules) |
| `learned.md` | **Structured instruction list** — what the agent has learned, decomposed into what / why / how |
| `skills/<skill>.md` | **Project addendum for one of the role's skills** — injected directly beneath that skill's bundled body |
| `skills/affinity.json` | Per-skill load / outcome / learning counters that drive which skills are eagerly loaded |
| `archive/learned-*.md` | Pre-optimization snapshots of the raw buffer, kept for audit |
| `consolidated.md` | Reviewed, LLM-synthesized document (optimized learned data) |
| `consolidation.json` | Metadata tracking the last consolidation review |
| `knowledge.json` | Current-needs checklist (versions to verify today) |
| `learning.json` | Learning policy (enabled/disabled, capture counters) |
| `profile.json` | Durable definition for project-created roles |

## Subcommands

| Command | Effect |
|---|---|
| `/agent-improve` | List all roles with project customizations |
| `/agent-improve <role>` | Show customization details for one role |
| `/agent-improve <role> show` | Same as above |
| `/agent-improve <role> update <text>` | Write new identity content for the role |
| `/agent-improve <role> refresh` | Reset identity.md + learned.md to empty templates (keeps config/knowledge) |
| `/agent-improve <role> capture` | Scan last agent output for `## LEARNED` blocks and persist them |
| `/agent-improve <role> optimize` | Distil captures into skill addenda + a consolidated document, then archive and reset the raw buffer (`consolidate` is an alias) |
| `/agent-improve <role> skills` | List the role's skills with project affinity and which have an addendum |
| `/agent-improve <role> skills <skill>` | Print one skill's project addendum |
| `/agent-improve <role> skills <skill> pin\|unpin` | Always / never keep that skill eagerly loaded |
| `/agent-improve <role> reset` | Delete ALL custom files for this role |
| `/agent-improve * reset` | Delete ALL custom files for every role |

## Knowledge capture

Agents output a `## LEARNED` section in their response to persist
project-specific patterns. The runtime captures these automatically at the
end of delegated subagent tasks, subject to:

- **Cooldown** — 120 seconds between captures per role
- **Frequency cap** — 3 captures per role per 30-minute window. The window rolls
  over on its own, so a long-lived project daemon does not exhaust the budget
  once and stop learning for the rest of the process's life.
- **Normalization** — each captured block is run through `normalizeLearnedEntry`
  before it qualifies as learned data:
  - Strips ephemeral artifacts (commit SHAs, timestamps, line numbers,
    PR/issue refs) so entries stay actionable across sessions
  - Drops narrative-only sentences ("When I did X...", "Today I found...")
    while salvaging any directive tail via deontic-verb detection
    ("had to use", "must be", "should")
  - Enforces a 600-character cap (truncates to the last fitting sentence
    boundary)
  - Rejects entries that are too short, too narrative, or code-only
  - Classifies each entry into one of four categories:
    `convention`, `pattern`, `warning`, or `fact`
- **Size limit** — the buffer is bounded at 8 KB. When a capture would exceed
  it, the cheapest entries are evicted (oldest first; plain facts before
  patterns, conventions and warnings). Size never *blocks* a capture: the old
  soft-limit gate had no path that could clear it, so a role that crossed 8 KB
  stopped learning permanently.

Capture runs on **failed and cancelled** tasks as well as successful ones — a
subagent that hit a wall and wrote down why is the highest-value source there
is. ACP-delegated agents are covered too.

Use `/agent-improve <role> capture` to manually re-scan any text for
`## LEARNED` blocks, bypassing the guards.

### Structured instruction list (capture-time consolidation)

Every capture **merges the new entry with all historical entries and
rewrites the entire `learned.md` buffer as a structured instruction list**.
The buffer is never an append-only journal — it is always a current,
consolidated snapshot of what the agent has learned.

The structured format groups entries by category and decomposes each into
three components:

| Component | Description |
|---|---|
| **What** | The directive itself — what the agent should do (e.g. "Always run pnpm typecheck before declaring work complete.") |
| **Why** | The reason behind the directive — derived from the entry's category and any project-specific signals in the text (e.g. "Established convention — skipping it risks regressions.") |
| **How** | Concrete, runnable anchors — commands, file paths, and package names extracted from backticks in the directive text (e.g. ``pnpm typecheck``, `packages/core/src/...`) |

#### Categories

| Category | Section heading | Trigger words | Example |
|---|---|---|---|
| **warning** | `## What to avoid` | avoid, never, must not, beware, pitfall | "Avoid mutating shared state in async handlers." |
| **convention** | `## What to do` | always, must, should, ensure, verify, before, after | "Always run pnpm typecheck before declaring work complete." |
| **pattern** | `## Patterns to follow` | use, prefer, choose, adopt, pattern, approach | "Use pnpm for monorepo package management." |
| **fact** | `## Project facts` | (default when no directive verb matches) | "The project uses vitest 2.x for unit tests." |

Categories are ordered warning-first in the rendered document so the
highest-signal entries (pitfalls) are seen first.

#### Example buffer

```markdown
# Learned instructions for `executor`

> Project-specific learning data for the `executor` agent. Each entry is a
> directive — read it as an instruction, not a journal entry.

## What to avoid

<!-- learned-stamp: category=warning; capturedAt=2026-07-24T13:44:00Z -->
- **Avoid mutating shared state in async handlers.**
  - *Why:* Known failure mode — skipping this has caused real defects in this
    codebase. The cost of getting it wrong outweighs the cost of the check.

## What to do

<!-- learned-stamp: category=convention; capturedAt=2026-07-24T13:44:00Z -->
- **Always run pnpm typecheck before declaring work complete.**
  - *Why:* Established convention — skipping it risks regressions. Project
    signals: guard before shipping.
  - *How:* `pnpm --filter @wrongstack/core typecheck`

## Patterns to follow

<!-- learned-stamp: category=pattern; capturedAt=2026-07-24T13:44:00Z -->
- **Use pnpm for monorepo package management.**
  - *Why:* This project's chosen approach — alternatives were considered and
    rejected.

---
*Last capture: 2026-07-24T13:44:00Z · 3 entries*
```

#### How it works

1. **Parse** — existing entries are read from the buffer (stamp metadata is
   recovered from hidden `<!-- learned-stamp: -->` comments)
2. **Normalize** — each new `## LEARNED` block is stripped of ephemeral
   artifacts, narrative framing, and classified
3. **Merge** — the new entry is merged with existing entries, deduplicating
   by content similarity (Jaccard ≥ 0.55 on normalized token sets)
4. **Decompose** — every entry is split into what / why / how
5. **Render** — the full structured document is written as the single source
   of truth

#### Writing good `## LEARNED` blocks

The runtime tells each agent how to write captureable entries. The key rules:

- **Write directives, not narratives.** "Always use X for Y" persists.
  "When I worked on X today I noticed Y" is rejected at capture time.
- **Be generic.** No commit SHAs, timestamps, line numbers, or PR refs.
  File paths, package names, and command names are fine — they anchor the
  lesson.
- **Front-load concrete anchors.** Commands in backticks and file paths are
  extracted into the "How" field automatically.

**Bad** (session log — rejected):
```
## LEARNED
When I worked on the telegram plugin today, commit 9c7682b84 had a race
condition in poll-lock at line 42 because writeFileSync wasn't using the
'wx' flag.
```

**Good** (directive — persists, then merges into the structured list):
```
## LEARNED
Always use the 'wx' (exclusive create) flag with writeFileSync when
implementing concurrent lock acquisition in `packages/core/src/.../poll-lock.ts`
— filesystem-level atomicity guarantees only one writer wins.
```

## Skill development (the point of the loop)

Learned directives are not filed as memory. They develop the agent's **skills**
for this project.

```
capture  →  route to a skill  →  optimize  →  <skill>.md  →  injected with the skill body
```

1. **Tag or route.** An agent marks the skill it is refining:
   `## LEARNED [skill: testing]`. Untagged directives are routed automatically
   when the wording makes the target obvious (vocabulary match against the
   role's own skill set), and stay role-level when nothing matches — a
   directive is never forced into the wrong skill.
2. **Distil.** `optimize` groups the routed directives per skill and writes
   `.wrongstack/agents/<role>/skills/<skill>.md`: the *delta* between the
   general skill and how it must be applied in this codebase. Without an active
   model the addendum is still written deterministically from the directives,
   so tagged learning is never stranded.
3. **Inject.** At spawn the addendum is appended directly beneath that skill's
   bundled body under `### Project practice for <skill>`, with the
   instruction to prefer it where the two differ. The agent reads one skill,
   refined for this project — not a skill plus a pile of recalled facts.

### Which skills get loaded

A role's curated set can hold more skills than the eager budget (3). The spawn
path ranks the **full** pool by project affinity rather than taking whichever
three were written first in the catalog:

| Signal | Effect |
|---|---|
| Directives routed to the skill | strongest — a skill this project developed outranks an unused sibling |
| Task success rate while loaded | Laplace-smoothed, so one failure does not bury a skill |
| Times loaded | small recency/usage nudge |
| `pin` | always selected |

With no recorded history every candidate scores equally and the curated order
is preserved, so a fresh project behaves exactly as before.

A skill that cannot be loaded — missing from the loader, gated behind a
capability the subagent lacks, or cut by the prompt budget — emits
`subagent.skills.dropped` instead of failing silently.

## Optimization (`optimize`)

The pass runs headlessly on whichever surface invoked it (CLI and WebUI share
one implementation):

1. Read the structured directives from `learned.md`
2. Distil each skill group into `skills/<skill>.md`
3. Synthesize the role-level `consolidated.md`
4. **Archive** the raw buffer to `archive/learned-<timestamp>.md` and reset it

Step 4 is what closes the loop. Consolidation used to leave `learned.md`
untouched, so a role over the size limit stayed over it forever; the archive
keeps the audit trail while the active buffer starts clean.

Once `consolidated.md` exists:

- `buildProjectContextualizedPrompt` prefers it over the raw `learned.md`
- Directives captured *after* the consolidation are appended under
  "Recently captured" — identified by capture timestamp, not list position
  (the structured buffer is sorted, so slicing by count returned the wrong
  entries)
- With no metadata to verify freshness, the raw buffer is served **and labelled
  as raw** rather than presented as consolidated

Metadata in `consolidation.json` tracks the post-prune entry count, byte
reduction, trigger source, model, archive path, and refreshed skills.

### Automatic optimization

The pass does not wait for a human. The fleet host runs a background scheduler
that watches captures and distils on its own:

- **Trigger** — a role becomes eligible when its raw buffer reaches
  `thresholdBytes` (default 8 KB), **or** when `minPendingSkillDirectives`
  (default 3) directives are routed to a skill that has no addendum yet.
  Waiting for the buffer to fatten would needlessly delay the thing the loop
  exists for, so the second condition usually fires first.
- **Debounce** — a burst of captures for one role collapses into a single pass
  (`debounceMs`, default 20 s).
- **Cooldown** — at most one automatic pass per role per `minIntervalMs`
  (default 6 h). Manual `optimize` ignores it.
- **Serialized** — one pass at a time process-wide, so a busy fleet cannot fan
  out N concurrent model calls.
- **Start-up sweep** — on the first fleet activity of a session every role is
  evaluated once, so a role that became eligible while nobody was looking is
  not stuck waiting for its next capture.
- **Failure backoff** — a failed pass backs off 5 min, doubling to 6 h. A dead
  provider degrades to "no optimization", never to a retry loop.
- **No model, still useful** — without an active model the pass writes the
  deterministic per-skill addenda anyway.

Each completed pass emits `agent.learning.optimized` (role, trigger, status,
refreshed skills).

Configuration lives under `fleet.learning.autoOptimize`:

```jsonc
{
  "fleet": {
    "learning": {
      "autoOptimize": {
        "enabled": true,              // master switch
        "thresholdBytes": 8192,
        "minEntries": 4,
        "minPendingSkillDirectives": 3,
        "minIntervalMs": 21600000,    // 6h
        "debounceMs": 20000,
        "sweepOnStart": true
      }
    }
  }
}
```

Set `enabled: false` to go back to manual-only distillation; `/agent-improve
<role> optimize` keeps working either way.

### WebUI equivalent

The **Self-Learning** tab in the WebUI Agent Roster view provides the same
capability:

- **Optimize** per agent and **Optimize All (N)** in bulk
- **Skills** panel — which skills are developed, their affinity counters, the
  addendum body, and a pin toggle
- **Proactive warnings** for agents whose buffer needs attention

## Sharing

`.wrongstack/agents/` is committed. What the `verifier` agent learned about
testing *this* codebase is a project asset; leaving it ignored meant every
clone and every CI run started the roster from zero. Runtime counters
(`skills/affinity.json`) and the pre-optimization `archive/` stay local.

## Examples

```
/agent-improve
/agent-improve executor show
/agent-improve executor update "Always run typecheck before reporting completion."
/agent-improve executor capture
/agent-improve executor consolidate
/agent-improve executor refresh
/agent-improve executor reset
```

See also: `/spawn` (fleet spawning), `/fleet` (fleet management).
