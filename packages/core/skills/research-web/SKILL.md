---
name: research-web
description: |
  Use this skill when searching the web for current, up-to-date data during
  a research phase — version checks, ecosystem changes, API deprecations,
  tool comparisons, or any claim that needs live verification against sources
  newer than the model's training cutoff.
  Triggers: user says "research", "current version", "is this still true",
  "latest", "what's new in", "breaking changes", "find current",
  "web research", "search the web", "look up".
version: 1.0.0
---

# Research Web — WrongStack

## Overview

Teaches the agent how to conduct current-data web research with discipline:
when to search, how to cross-validate, how to inject findings for reuse, and
how to delegate research to subagents. Complements the `research-web` mode
(which provides tool prioritization and behavioral gating); this skill
provides the deep methodology and patterns the mode prompt can't fit.

## Rules

1. Verify before claiming. Never state a version number, deprecation status,
   or API surface from training data without a live check.
2. Two-source minimum. Single-source claims are tentative; two agreeing
   sources is a signal; three is confirmation.
3. Inject, don't repeat. After research, use `context_manager` with `add_note`
   to inject a structured summary. Never re-research the same topic.
4. Respect the stop rule. 2-3 searches + 1-2 fetches per topic. If no clear
   answer after that, surface the ambiguity rather than research-looping.
5. Cite every claim. Domain name minimum; date if visible on the page.
6. Match tool to task. `search` for discovery, `fetch` for detail,
   `fetch` for raw API responses, `search` for source-code-specific queries.

## Research Workflow Taxonomy

Not every research task needs the same approach. Match the workflow to the need:

### Quick Lookup (1-2 turns)
**When**: "What's the latest version of React?" "Is package X still maintained?"
**Pattern**:
```
search("React latest stable version 2025")  →  discover version
fetch("https://react.dev/versions")          →  verify against authoritative source
context_manager add_note("## Research: React version\n- 19.2.0 (March 2025)\n- Source: react.dev")
```
**Budget**: 1 search + 1 fetch = ~2000 tokens. Done in one turn.

### Deep Investigation (3-4 turns)
**When**: "How has Next.js middleware changed across 14.x → 15.x?"
**Pattern**:
```
Turn 1: search("Next.js middleware changes 14 to 15") → collect URLs
Turn 2: fetch(upgrade guide), fetch(changelog)     → parallel fetches
Turn 3: cross-reference, inject structured findings
```
**Budget**: 2 searches + 2-3 fetches = ~5000 tokens. Use parallel fetches.

### Landscape Survey (fan-out)
**When**: "Compare the top 5 React state management libraries in 2025"
**Pattern**: Delegate to subagents. Each researches one library, leader aggregates.
See "Subagent Delegation" section below.

## Tool Selection Guide

| Tool | Best for | Avoid for |
|------|----------|-----------|
| `search` | Broad discovery, finding current URLs, getting an overview | Deep detail (use `fetch` after) |
| `fetch` | Reading a specific page for detail, authoritative confirmation | Broad queries (use `search` first) |
| `search` | Technical docs, source code, API references (DuckDuckGo) | General web queries (use `search`) |
| `fetch` | Raw API responses (JSON), registry endpoints, structured data | HTML pages (use `fetch` for markdown conversion) |
| `context_manager` | Injecting research findings into conversation for future turns | Research itself (this is the *output* tool) |

### Decision heuristic
```
                   ┌─────────────────┐
                   │ What do I need? │
                   └────────┬────────┘
           ┌────────────────┼────────────────┐
           ▼                ▼                 ▼
     "Discover URLs"   "Read a page"    "Raw API data"
           │                │                 │
     search        fetch           fetch
           │                │
           └────────┬───────┘
                    ▼
            context_manager
              add_note
```

## Source Quality Evaluation

Rate every source before citing it:

| Tier | Examples | Trust |
|------|----------|-------|
| **Primary** | Official docs, GitHub releases, registry APIs, RFCs | Cite as fact |
| **Secondary** | Well-known tech blogs, conference talks by maintainers | Cite with "according to" |
| **Tertiary** | Stack Overflow, Reddit, personal blogs, LLM-generated content | Corroborate before citing |

**Recency check**:
- Package version: must be ≤ 6 months old to claim "current"
- API change: must reference the specific version that introduced it
- Deprecation claim: must cite the deprecation notice (not just "I heard")
- Ecosystem trend: multiple sources from the current year

## Injection Format Templates

Structured `add_note` formats for different research outcomes. The format matters —
future turns need to parse these quickly without re-reading raw search results.

### Version check

```
## Research: [package] version
- Current latest: [version] ([date])
- Previous: [version] (for context)
- Registry source: [npm/pypi/crates.io URL]
- Confirmed via: [source URL]
```

### API / breaking change

```
## Research: [package] [feature] changes
- [Version]: [what changed]
- [Version]: [what changed]
- Breaking: [list of breaks]
- Migration path: [if documented]
- Source: [upgrade guide URL]
```

### Ecosystem comparison

```
## Research: [topic] comparison
- [Tool A]: [key points, version, status]
- [Tool B]: [key points, version, status]
- Recommendation: [with rationale]
- Sources: [URL, URL]
```

### Null result (important — prevents re-search)

```
## Research: [topic] — no current changes found
- Searched: [query, query]
- Result: No breaking changes / deprecations / version bumps found
- Checked on: [date]
```

**Always include a null-result note.** Without it, future turns may re-research
the same topic thinking the data was never gathered.

## Subagent Delegation

For landscape surveys and parallel research, delegate to subagents carrying
this skill. The `research` and `search` roster roles are tuned for this.

### Fan-out pattern (parallel)

```typescript
// Leader: fan out one topic per subagent
batch_tool_use([
  {
    tool: "delegate",
    input: {
      task: "Research current state of Zustand: latest version, breaking changes in 5.x, ecosystem position. Inject findings via context_manager.",
      role: "research"
    }
  },
  {
    tool: "delegate",
    input: {
      task: "Research current state of Jotai: latest version, breaking changes, ecosystem position. Inject findings via context_manager.",
      role: "research"
    }
  },
  {
    tool: "delegate",
    input: {
      task: "Research current state of Valtio: latest version, breaking changes, ecosystem position. Inject findings via context_manager.",
      role: "research"
    }
  },
])
```

### Sequential deep-dive

```typescript
// Leader: one topic, phased research
delegate({
  task: "Research React 19 Server Components: what changed from 18→19, current best practices for 'use client' boundaries, known pitfalls. Cross-reference react.dev docs and the GitHub release notes. Inject structured findings.",
  role: "research"
})
```

### Subagent budget guidance

| Research type | `maxIterations` | `maxToolCalls` | Notes |
|---|---|---|---|
| Quick lookup | 3 | 6 | 1 search + 1 fetch + inject |
| Deep investigation | 8 | 20 | Multiple searches + cross-ref |
| Landscape survey | 12 | 30 | Multiple searches + fetches per topic |

## Cross-Validation Patterns

### When sources agree
```
Source A (official docs): React 19.2.0
Source B (npm registry):  19.2.0
Source C (GitHub releases): 19.2.0
→ Cite as confirmed. No need to fetch a 4th source.
```

### When sources disagree
```
Source A (blog post):       Next.js 15.2 deprecated middleware edge runtime
Source B (official docs):   Middleware now defaults to Node.js, edge still available
→ Dig deeper. The blog conflated "default change" with "deprecation".
→ Fetch the actual upgrade guide for the precise language.
→ Flag the disagreement in your findings.
```

### When only one source exists
```
Source A (GitHub issue comment): "This API is being removed in v4"
→ Mark as TENTATIVE. State: "One source claims... cannot confirm."
→ If the claim is critical, search specifically for confirmation.
→ Otherwise, move on — don't spend budget chasing unconfirmed rumors.
```

## Cost Awareness

| Action | Approximate cost | When to use |
|--------|-----------------|-------------|
| `search` (5 results) | ~500 tokens | Always first — cheap discovery |
| `fetch` (single page) | ~1000-2000 tokens | Only for authoritative sources |
| `context_manager add_note` | ~0 tokens (metadata op) | After every research cycle |
| `delegate` (quick lookup subagent) | ~$0.05-0.15 | When research would bloat your context |
| `delegate` (deep investigation) | ~$0.20-0.50 | Landscape surveys only |

**Rule of thumb**: Don't spend more on research than the answer is worth.
A version check shouldn't cost $0.50. A landscape survey justifying an
architecture decision might be worth $2.00.

## Anti-Patterns

### Re-researching known data

```typescript
// ❌ Turn 5: Agent forgets it already researched React version
search("React latest version")

// ✅ Turn 2: Agent injected findings via add_note
// Turn 3-5: Agent sees the note in conversation — skips re-search
```

### Fetching without searching first

```typescript
// ❌ Guessing URLs wastes fetches
fetch("https://react.dev/blog/2025/03/15/react-19-2")  // 404

// ✅ Search discovers the real URL first
search("React 19.2 release blog post")
fetch(<result from search>)
```

### Injecting raw dumps

```typescript
// ❌ Bloating context with raw JSON
context_manager add_note(JSON.stringify(searchResults))

// ✅ Structured summary
context_manager add_note("## Research: React version\n- 19.2.0\n- Source: react.dev")
```

### Single-source claims

```typescript
// ❌ One blog post becomes "truth"
"The React team recommends X"  — based on one Medium article from 2023

// ✅ Cross-referenced
"The React docs recommend Y (react.dev). A 2024 blog post also suggests Y.
One 2023 article suggests X, but this appears outdated."
```

### Research-looping

```typescript
// ❌ 7 searches on the same topic, each slightly rephrased
search("React 19 new features")
search("React 19 what changed")
search("React 19 release notes changes")
search("React 19 difference from 18")
// ...

// ✅ 1-2 broad searches, then targeted fetches
search("React 19 release notes breaking changes")
fetch(<react.dev blog>)
fetch(<GitHub releases>)
// Done. Inject findings.
```

### Researching during tactical work

```typescript
// ❌ User asks for a quick null-check fix, agent starts web searching
User: "fix the null deref in auth.ts line 42"
Agent: search("TypeScript null check best practices") // NO

// ✅ Research mode is for analysis/discussion phases, not tactical edits
// The agent already knows how to fix a null deref — just fix it.
```

## Workflow

```
1. TRIGGER    — User asks for current data OR agent realizes knowledge is stale
2. CLASSIFY   — Quick lookup? Deep investigation? Landscape survey?
3. SEARCH     — search with 5-8 results for broad discovery
4. FETCH      — fetch 1-2 authoritative results for detail (parallelize if >1)
5. VALIDATE   — Cross-reference: 2+ sources agree? Flag single-source claims
6. INJECT     — context_manager add_note with structured findings
7. CITE       — In your response, cite sources for every factual claim
```

## Skills in scope

- `tech-stack` — for package version verification and ecosystem validation
- `node-modern` — for Node.js-specific version and API checks
- `react-modern` — for React-specific version and API checks
- `security-scanner` — for CVE and vulnerability research
- `prompt-engineering` — for crafting effective search queries
- `multi-agent` — for fanning out research to subagents
- `output-standards` — for standardized `<nextsteps>` formatting
