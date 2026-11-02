---
name: doc-coauthoring
description: "Specs, RFCs, design docs, PRDs and ADRs: context gathering, decision framing, options and trade-offs, review asks, cold-reader test. Use when drafting or restructuring a substantial technical document, writing an architecture decision record, turning notes or a thread into a proposal, or preparing a doc for review. Not for status updates, announcements or postmortems (use internal-comms)."
version: 1.2.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when a request asks to write or improve an RFC, design doc, PRD, ADR, proposal or technical specification."
metadata:
  routing-group: workflow
---

# Doc Co-Authoring

## Selection card
- Task: Co-author decision documents (RFC, design doc, PRD, ADR) that get a specific decision made.
- Start: Ask for the decision, the decider, the deadline, the audience and the constraints; read existing docs and ADRs in the repo (docs/adr, docs/rfcs or the project's convention) and the source notes or threads.
- Finish: the doc leads with its decision and ask, a cold reader restated the decision, reasons and main risk correctly, open questions have owners, and the file sits in the repo's doc convention.

## Overview

A design document exists to get a specific decision made by specific people: write for the reader who missed every meeting, put the decision and the ask first, and prove the doc works by testing it on a reader with no context.
The workflow runs in three stages (reviewed 2026-11-02): context gathering, section-by-section drafting with the author, and cold-reader testing.
The author owns the content and the decision; you own structure, clarity and the gaps you surface.

## Rules

1. Name the decision, the decider and the deadline before drafting. A doc with no decision is a different genre (explainer, status update); say so and route it.
2. Bottom line up front: the first screen gives context in two sentences, the proposal, the ask ("Approve X by 14 Nov") and the main trade-off. A reader who stops there can act.
3. Separate facts, assumptions and opinions. Every number carries a source and date; unknowns become open questions with an owner.
4. Compare real alternatives, including the status quo, against the same explicit criteria. A strawman option is worse than none.
5. State goals and non-goals explicitly; scope creep in review is answered by pointing at the non-goals.
6. Spell out consequences both ways: cost, risk, what becomes harder, reversibility (one-way or two-way door), rollout and rollback.
7. Never invent facts, metrics, quotes or stakeholder positions. Mark gaps as `[TODO: owner, question]` and propose wording as suggestions the author accepts.
8. Accepted ADRs are immutable: a change is a new ADR that supersedes the old one, with links both ways and statuses updated (Proposed, Accepted, Superseded, Deprecated).

## First moves by situation

| Request | First moves |
|---|---|
| Blank page or notes dump | Ask decision, decider, deadline, audience, constraints; outline headings with a one-line intent each before any prose |
| Thread or meeting notes to proposal | Extract claims, options and objections; attribute positions neutrally; confirm facts with their owners; link the sources |
| ADR | Title, Status, Context, Decision, Consequences on one or two pages; numbered file matching the repo convention |
| RFC or design doc | Summary and ask, Motivation, Goals and non-goals, Proposal, Alternatives, Risks, Rollout and rollback, Open questions |
| PRD | Problem with evidence, users, success metrics with baseline and target, scope, prioritized requirements, out of scope, launch criteria |
| Doc too long | Move detail to appendices; one idea per section; tables for comparisons; cut throat-clearing |
| Preparing for review | Name reviewers and what each must answer; deadline; how comments get resolved and where the decision is recorded |
| Contested decision | Steelman each position; separate disagreements about facts from disagreements about criteria or weights |

## Patterns and pitfalls

- **Buried ask** — the decision appears on page four; reviewers debate details without knowing what they are approving.
- **Solution first** — the proposal precedes evidence of the problem, so review re-litigates whether the problem exists.
- **Weasel words** — "fast", "scalable", "soon", "most users" become numbers, dates and percentages with sources.
- **Undefined jargon** — acronyms defined at first use; add a glossary past about five terms.
- **Hidden dependencies** — "we will reuse X" without confirming X's owner, capacity and roadmap.
- **Metrics without baselines** — a target with no current value cannot be measured; record both and the measurement method.
- **Diagram sprawl** — one diagram per question, each with a caption saying what it shows; diagrams as code (Mermaid) where the repo renders them.
- **Review theater** — blanket "LGTM" requests; ask each reviewer a specific question.
- **Decision lost in comments** — record the outcome, decider and date in the doc itself, then update its status.
- **Stale docs** — status and last-updated date at the top; superseded docs link to their replacement.

## Template

```markdown
# RFC-NNNN: <Title as the decision>
Status: Proposed | Accepted | Superseded by RFC-MMMM · Owner: <name> · Decider: <name> · Decide by: YYYY-MM-DD · Updated: YYYY-MM-DD

## Summary and ask
<Two sentences of context. The proposal. The ask and deadline. The main trade-off.>

## Problem and evidence
## Goals and non-goals
## Proposal
## Alternatives considered
| Criterion | Status quo | Option A | Option B |
## Risks, consequences and reversibility
## Rollout and rollback
## Open questions (owner, due date)
## Decision record (date, decider, outcome)
```

## Workflow

1. Gather context: the questions above, source material, existing docs and code facts (confirm system claims against the repository).
2. Agree on a skeleton: headings with one-sentence intents, confirmed by the author.
3. Draft section by section; the author confirms facts; gaps become TODOs with owners.
4. Tighten: rewrite the summary last, cut 20-30%, convert comparisons into tables.
5. Cold-reader test: give only the document to a fresh reader (or a fresh subagent with no context) and ask them to state the decision, the reasons, the main risk and their next action, and to list their questions. Fix every gap they reveal.
6. Prepare review: reviewers, specific questions, deadline, status; save in the repo convention and link it from the index.

## Proof

- Cold-read record: the fresh reader's restatement matches the author's intent, and their questions are answered in the doc.
- Sources: every number and external claim links to a source or is labeled an estimate.
- Links: `npx markdown-link-check docs/rfcs/0007-example.md` (or the repo's link checker) reports no dead links.
- Diagrams: `npx -p @mermaid-js/mermaid-cli mmdc -i flow.mmd -o flow.svg` renders without errors when Mermaid sources are used.
- Lint: the repo's markdown linter passes if it has one.
- Length: `wc -w` on the summary keeps it readable in about one minute.

## Stop and ask

- Facts, metrics or stakeholder positions are unknown; ask instead of inventing.
- The doc would commit people, teams or budget without their agreement.
- Sensitive material (vulnerabilities, personnel, customer data) would go into a widely shared doc.
- Author and reviewers disagree on what decision the doc is for.

## Before returning

- [ ] Decision, decider, deadline and ask stated on the first screen
- [ ] Problem evidence precedes the proposal; goals and non-goals explicit
- [ ] At least two real alternatives, including the status quo, compared on stated criteria
- [ ] Consequences, risks, reversibility and rollback covered
- [ ] Every number sourced or labeled as an estimate; no invented facts or quotes
- [ ] Cold-reader test run and its gaps fixed
- [ ] Open questions have owners and dates; status and location follow repo convention

## Sources

[Documenting architecture decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions), [Design docs at Google](https://www.industrialempathy.com/posts/design-docs-at-google/), [ADR resources](https://adr.github.io/).

## Skills in scope

- sdd — specification-driven development and testable acceptance criteria.
- internal-comms — status updates, incident postmortems and announcements.
- docx — exporting finished specifications into formal Word documents.
- codebase-navigation — grounding claims about the current system in the actual code.
