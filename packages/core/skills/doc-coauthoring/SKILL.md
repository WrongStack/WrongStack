---
name: doc-coauthoring
description: "Collaboratively author technical specifications, RFCs, PRDs, ADRs, and decision documents through structured context gathering, iterative refinement, and blind reader testing. Use when drafting substantial documentation, architecture proposals, or engineering design records."
version: 1.0.0
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "drafting substantial documentation, architecture proposals, or engineering design records."
metadata:
  routing-group: workflow
---

# Doc Co-Authoring — WrongStack

## Selection card
- Task: Co-author structured specs, PRDs, RFCs, and decision docs.
- Start: Initiate the 3-stage authoring protocol (Context Gathering, Section Refinement, Reader Testing).
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Collaborative documentation bridges the gap between tacit engineer knowledge and reader comprehension.
Rather than generating an unreviewed wall of text, lead the author through an active 3-stage pipeline:
1. **Context Gathering & Discovery**
2. **Iterative Refinement & Structural Synthesis**
3. **Cold Reader Testing (Blind Validation)**

## The 3-Stage Pipeline

### Stage 1: Context Gathering & Discovery
Before writing a single paragraph, ask targeted discovery questions:
1. **Document Archetype**: RFC, PRD, Architecture Decision Record (ADR), or System Design Spec?
2. **Primary Reader & Decision Maker**: Staff engineers, cross-functional leads, or external auditors?
3. **Desired Impact**: Approving a breaking migration, establishing a security standard, or scoping a milestone?
4. **Context Dump**: Request raw notes, Slack transcripts, existing tickets, and previously rejected alternatives.

### Stage 2: Section Refinement & Synthesis
Build the document section by section with disciplined technical depth:
- **Problem Statement**: Ground the problem in concrete observable pain, metrics, or blockers.
- **Constraints & Non-Goals**: Explicitly boundary what will NOT be solved in this phase.
- **Proposed Architecture**: Detailed schema, sequence diagrams, failure modes, and data flows.
- **Trade-off Matrix**: Compare at least two rejected alternatives with concrete trade-off rationale.
- **Rollout & Rollback Plan**: Migration gates, backward compatibility, and abort criteria.

### Stage 3: Cold Reader Testing (Blind Validation)
Audit the completed draft from the perspective of an engineer who has zero prior context:
- **Blind Spot Audit**: Identify unstated assumptions, tribal jargon, or undefined acronyms.
- **Adversarial Critique**: Formulate the 3 hardest questions a reviewer or staff auditor will ask.
- **Clarity Verification**: Check whether an engineer can implement the system solely from this document.

## Document Template Structure

```markdown
# [RFC/ADR/PRD-XXX]: Title
- Status: Proposed | Approved | Superseded
- Author(s): @author
- Date: YYYY-MM-DD
- Deciders / Reviewers: @team

## 1. Context & Problem Statement
## 2. Goals & Explicit Non-Goals
## 3. Proposed Solution & Architecture
## 4. Evaluated Alternatives & Trade-offs
## 5. Security, Reliability & Performance
## 6. Migration, Deployment & Rollback Strategy
## 7. Open Questions & Reader Testing Feedback
```

## Acceptance checks

- Document passes all 3 stages (Context Gathering, Section Synthesis, Cold Reader Testing).
- Goals, non-goals, and evaluated alternatives are explicitly documented.
- All technical terms, acronyms, and dependencies are defined without relying on unstated tribal knowledge.
- Deliverable is saved in the repository's standard documentation path.
