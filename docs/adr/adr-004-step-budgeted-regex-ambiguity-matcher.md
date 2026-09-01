# Architecture Decision Record — 004: Step-Budgeted Regex Ambiguity Matcher

| Field | Value |
|---|---|
| **Date** | 2026-09-01 |
| **Status** | Proposed |
| **Deciders** | WrongStack core team (design round; pending review) |
| **Supersedes** | — |
| **Superseded by** | — |

## Context

`compileUserRegex` in `@wrongstack/primitives` (packages/primitives/src/regex-guard.ts) is the
ReDoS gate for every user/LLM-supplied pattern in the repo (tools `grep`/`replace`/`json`,
core `session-reader` + `autonomous-runner`, kanban `file_matches`). Four bug-hunter rounds
(commit `62599ac1b`) hardened its ambiguous-alternation detector: named-group prefixes,
nested-group recursion, single-token char-set intersection, and fixed-length multi-token
per-position intersection.

Two residual classes remain, documented in-source and in memory, that **no pairwise
branch-comparison model can detect**:

1. **Variable-length token sequences** — `(a{1,2}|b)+`, `(a?*b|…)+`-family: branches whose
   repetition bounds differ, so no fixed per-position alignment exists.
2. **Self-decomposition ambiguity** — `((?:a+)|b)+`, `(?<g>a+)+`, `(a*)+`: a branch whose
   language, concatenated with itself, re-covers a single iteration. This is the classic
   `(a+)+` hidden behind a wrap; it compares a branch against *itself repeated*, which is
   outside the branch-vs-branch universe of the current detector by construction.

V8's regex engine is synchronous and uninterruptible, so the guard must decide
**statically** — it cannot "just try the match" (a catastrophic match cannot be aborted).

A throwaway feasibility spike (`.temp_files/design-round-nfa-ambiguity/`, deleted after this
round) validated the mechanism claims empirically before this ADR:

- **Detection is proven (13/13):** a Thompson NFA of the quantified group's content, wrapped
  in a `+` loop and checked for path ambiguity, flags every case in both residual classes and
  every catch from rounds 11–14.
- **The naive checker is falsified (0/9 precision):** the asynchronous-ε squared product
  flags *every* legitimate shape too, including `(a|b)+`. Root cause: ε-timing differences —
  the same parse paused at different ε-points, e.g. `(J, A₂)` — are counted as divergence.
- **Precision ground truth:** derivation during the spike identified the correct formal
  foundation (below), which also proves `(a|ab)+` and `(ab?|a)+` are *codes* — genuinely
  unambiguous — meaning the precise layer will be **more accurate than the existing
  prefix-relation heuristic**, which over-blocks them today (accepted bias per guard
  doctrine).

## Decision

**Proposed:** add a final semantic layer to the guard — a **step-budgeted ambiguity
matcher** built from two standard decidability constructions, running only on quantified
groups whose content parses into the guard's token subset, additive to (never overriding)
the existing static layers:

1. **Parse-ambiguity within one iteration** — ε-**eliminate** the content's Thompson NFA
   (ε-closure transform), then run the **squared-product construction** on the ε-free NFA:
   ambiguous iff some divergent product state `(p,q), p≠q` backward-reaches an accepting
   pair. ε-elimination first is the fix for the spike's false positives: it collapses
   ε-timing (same parse, different pause points) while preserving genuine branch choices as
   distinct edges.
2. **Decomposition ambiguity across iterations** — `X+` is unambiguous iff `L(X)` is a
   **code** (uniquely decodable), decidable by the **Sardinas–Patterson algorithm** over the
   content's ε-free NFA (residual suffix sets computed as automaton products; the residual
   sequence over a finite state-set lattice terminates). This is the only mechanism that can
   see `(a+)+`-style self-decomposition, because the ambiguity lives *between* iterations,
   not between branches.

**"Step-budgeted"** means the budget binds the **checker**, not the pattern: every BFS /
product / SP step counts against a cap (≈60k for ≤256-char patterns). Exhaustion is
reported as `budget` and the caller **under-rejects** (allows) — preserving the guard's
soundness doctrine: *never reject without proof*. A positive `ambiguous` verdict is a
proof (two distinct accepting paths / a code violation), and the implementation should
retain enough parent pointers to emit a **witness string** for the rejection reason.

### Scope and integration

- New module `packages/primitives/src/regex-ambiguity.ts` (the guard file is ~700 lines;
  keep the layer separate), imported by `compileUncached` via the existing
  `hasAmbiguousQuantifiedAlternation` probe — parity across the three historical entry
  points is automatic (single canonical implementation).
- API: `detectQuantifiedAmbiguity(content: string, budget): 'ambiguous' | 'unambiguous' |
  'unparsable' | 'budget'`. Unparsable (lookarounds, backrefs, `\p`, mid-content anchors,
  copy-count caps) and budget both **allow** — sound under-rejection, consistent with
  rounds 11–14.
- Layering: static layers run first (O(small), better rejection messages); the semantic
  layer runs last and only **adds** rejections. Existing verdicts are never relaxed by it
  (relaxing the prefix heuristic where SP proves code-ness is explicit future work, not
  this design).
- Bounded expansions: finite `{n,m}` copies capped (64) under-approximate soundly;
  unbounded tails use ε-loops, never expansion.

## Reasons

- **Completeness for the subset:** the two constructions together cover exactly the two
  residual classes *and* subsume all four previous rounds' catches (spike: 13/13 detection)
  with one semantic mechanism instead of five stacked heuristics.
- **Precision:** SP decides code-ness exactly; the ε-free squared construction decides
  parse ambiguity exactly. The spike's all-flag result demonstrates why the naive form was
  rejected rather than shipped.
- **Soundness doctrine preserved:** rejection requires a certificate (witness), budget
  exhaustion under-rejects. No wall-clock semantics leak into a static gate.
- **Bounded cost:** pattern length is already capped at 256; NFA states ≤ ~3× pattern;
  squared product ≤ states²; SP residuals over a finite lattice — all under the checker
  budget, target < 1ms per pattern (perf-ratchet baseline required per the project's
  performance contract before merge).

## Consequences

### Positive

- Both residual classes closed for the parseable subset; the guard's detector becomes
  semantically grounded rather than heuristic-only.
- Rejection reasons can carry a concrete witness string ("'aa' has two decompositions").
- The foundation (code theory) is textbook-decidable — no novel algorithms to maintain.

### Negative

- ~350–450 lines of new automata code in a security-critical path: needs the strongest
  test battery of the guard suite (all 38 existing verdicts must be preserved verbatim;
  new pins for both residual classes; a property test comparing verdicts against
  brute-force decomposition enumeration on small random patterns; budget-exhaustion
  under-reject path pinned).
- Unparsable shapes (lookarounds, backrefs) remain outside coverage — documented residual,
  same as today.
- The precision gap vs the prefix heuristic (e.g. `(a|ab)+` is a code) becomes visible:
  users may ask why a "less wrong" layer coexists with an over-blocking one. Answer is
  doctrine (additive-only), documented here.

## Alternatives Considered

1. **Naive asynchronous-ε squared product** (the spike as first written) — sufficient
   detection, zero precision (9/9 false positives incl. `(a|b)+`). Rejected on evidence.
2. **Pure step-budgeted backtracking simulator** (budget-abort ⇒ reject) — rejection
   without a certificate; subject-generation-dependent; wall-clock-ish semantics in a
   static gate. Rejected as the primary mechanism; its budget concept survives as the
   checker-side cap.
3. **Linear-time engine (RE2-style) for actual matching** — would change runtime semantics
   for tool callers (captures, backrefs). Out of scope: the guard only needs verdicts.
4. **More pairwise heuristics** (branch-vs-concatenation prefix checks) — whack-a-mole;
   cannot ever see self-decomposition. Rejected.

## When to Re-evaluate

- If the tool surfaces grow patterns with lookarounds/backrefs under quantifiers, extend
  the parser subset (lookarounds need constraint-aware semantics — not ε-opaque — before
  they can be covered soundly).
- If the prefix heuristic's over-blocking becomes a user complaint, propose the
  SP-informed relaxation as its own ADR (it can *prove* code-ness now).
- If checker latency exceeds the perf budget on real tool traffic, revisit the budget cap
  or memoize per-(content-hash) verdicts.
