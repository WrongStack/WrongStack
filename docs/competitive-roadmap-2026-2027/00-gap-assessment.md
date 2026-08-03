# Competitive Gap Assessment

**Assessment date:** 2026-07-11  
**Source:** Historical competitive analysis, reconciled into this roadmap on 2026-07-11.
**Purpose:** Validate and normalize the report before turning it into implementation work.

## Executive analysis

The report identifies the right strategic pressure: MCP alone is no longer a differentiator, and WrongStack needs deeper workflows, mature surfaces, measurable reliability, and a stronger ecosystem. The repository review changes the interpretation of several gaps, however.

The main problem is not a lack of primitives. WrongStack already has browser access through MCP, vision input, a generic test tool, broad session/telemetry infrastructure, Sage defaults, and a functioning HQ dashboard. The competitive gap is usually one of productization: lifecycle ownership, cross-surface parity, safe defaults, evidence capture, distribution, evaluation, and operational trust.

This leads to four planning conclusions:

1. Prefer completing shared contracts over adding disconnected tools.
2. Put governance and quality work before remote execution, deployment, and autonomous PR creation.
3. Use MCP for vendor-specific breadth while owning stable first-party workflows for common daily tasks.
4. Measure reliability and benchmark behavior early so later feature expansion has a trustworthy baseline.

## Classification legend

- **Confirmed:** the capability is materially absent.
- **Partial:** useful primitives exist, but the report's desired product outcome is not complete.
- **Retired:** the report statement is already implemented or inaccurate; no standalone implementation plan is needed.
- **Duplicate:** the same gap appears elsewhere and is handled by one plan.

## Tool ecosystem

| Report item | Assessment | Evidence/interpretation | Roadmap |
|---|---|---|---|
| Browser automation | Partial | Playwright MCP preset and browser-agent instructions exist; first-party lifecycle and surface parity do not. | [02](02-first-party-browser-automation.md) |
| Database tools | Confirmed | No first-party bounded query/schema/migration contract exists. | [04](04-database-tooling.md) |
| Image/media | Partial | Vision-capable model input exists; normalized OCR/generation/artifact workflows do not. | [06](06-multimodal-media-workflows.md) |
| Deployment/cloud/IaC | Partial | Shell, skills, security scanning, and MCP can reach these systems, but there is no plan-first portable deployment workflow. | [07](07-deployment-cloud-iac-workflows.md) |
| API testing | Partial | Generic fetch and shell tools exist; OpenAPI-aware validation and chained scenarios do not. | [05](05-api-contract-testing.md) |
| Browser-aware test runner | Partial | Generic `test` and Playwright infrastructure exist; integrated server/browser/evidence orchestration does not. | [03](03-browser-aware-e2e-runner.md) |

## UI and surfaces

| Report item | Assessment | Evidence/interpretation | Roadmap |
|---|---|---|---|
| Desktop maturity | Partial | Electron shell exists; distribution, signing, updates, and release smoke coverage remain. | [15](15-desktop-distribution.md) |
| HQ maturity | Partial, report stale | Live events, alerts, history, persistence, and React dashboard shipped; Phase 7 hardening remains. | [16](16-hq-hardening-and-operations.md) |
| Mobile/responsive | Confirmed | Desktop-first layouts still need explicit small-screen journeys. | [17](17-responsive-webui.md) |
| TUI rich rendering | Partial | Ink rendering exists; richer Markdown/diff/image and long-output behavior can improve. | [18](18-rich-tui-rendering.md) |
| Cross-surface live collaboration | Confirmed, strategic | Mailbox/session coordination is not collaborative cursor or artifact editing. | [26](26-live-cross-surface-collaboration.md) |

## MCP protocol and operations

| Report item | Assessment | Evidence/interpretation | Roadmap |
|---|---|---|---|
| Resources/prompts | Confirmed | Current client/server capability is tool-centric. | [08](08-mcp-resources-and-prompts.md) |
| Auth/sampling | Confirmed | No MCP OAuth or governed sampling path is present. | [09](09-mcp-authentication-and-sampling.md) |
| Marketplace | Partial | Presets and management exist; pinned registry installation and trust metadata do not. | [11](11-mcp-registry-and-installation.md) |
| Rich output | Partial | Tool results are text-oriented; typed rich content needs end-to-end preservation. | [10](10-mcp-rich-content.md) |
| Health monitoring | Partial | Lifecycle/reconnect states exist; service-level latency/error/operations telemetry is limited. | [12](12-mcp-health-and-operations.md) |

## Memory and continuity

| Report item | Assessment | Evidence/interpretation | Roadmap |
|---|---|---|---|
| Sage default | Retired | Project invariants state it is the default on CLI/TUI/WebUI/SimpleUI/Desktop. | None |
| Vector/semantic search | Confirmed | Current retrieval is lexical/graph/anchor-oriented. | [13](13-semantic-Sage-retrieval.md) |
| Cross-session continuity | Partial | Sessions and memory persist, but explicit handoff/resume state can improve. | [14](14-cross-session-continuity-and-project-state.md) |
| Multi-session state machine | Partial | SDD, plans, worktrees, and mailbox state exist in separate models; a shared versioned project-state contract is missing. | [14](14-cross-session-continuity-and-project-state.md) |

## Autonomy and governance

| Report item | Assessment | Evidence/interpretation | Roadmap |
|---|---|---|---|
| Path-based policy UI | Confirmed | Runtime policy exists; safe visual authoring and decision explanation do not. | [19](19-policy-authoring-experience.md) |
| RBAC/team policy | Confirmed | Current model is principally local/single-user. | [20](20-enterprise-governance.md) |
| Immutable audit trail | Partial | Session/HQ audit data exists; a tamper-evident organization ledger does not. | [20](20-enterprise-governance.md) |
| Time-based policy | Confirmed | No general scheduled permission condition is established. | [20](20-enterprise-governance.md) |
| Brain determinism/evaluation | Partial | Exact option validation exists; replayable decision evaluation and regression gates remain. | [21](21-brain-evaluation-and-replay.md) |

## Test, quality, and benchmarks

| Report item | Assessment | Evidence/interpretation | Roadmap |
|---|---|---|---|
| Coverage reporting | Confirmed | Script exists, but a reliable published CI baseline is missing. | [22](22-quality-engineering-program.md) |
| CLI/TUI/Desktop E2E | Confirmed | WebUI/Playwright coverage exists; other surfaces need dedicated harnesses. | [22](22-quality-engineering-program.md) |
| Flaky-test tracking | Confirmed | No owned retry/quarantine intelligence is evident. | [22](22-quality-engineering-program.md) |
| Visual regression | Partial | HQ visual smoke coverage exists; systematic critical-state baselines do not. | [22](22-quality-engineering-program.md) |
| Cross-platform tests | Partial, report stale | CI already runs Ubuntu and Windows; targeted macOS/release/platform depth remains. | [22](22-quality-engineering-program.md) |
| Public benchmark results | Confirmed | Aider Polyglot and SWE-bench harnesses exist; transparent recurring publication does not. | [23](23-public-benchmark-transparency.md) |

## Community and strategic expansion

| Report item | Assessment | Evidence/interpretation | Roadmap |
|---|---|---|---|
| Planned slash commands | Partial, report stale | `/security` is registered; `/git`, `/health`, `/metrics`, and `/plan` remain the relevant command work. | [01](01-operational-slash-commands.md) |
| Skill marketplace | Partial | Skill search/install and a registry adapter exist; package versioning, dependency resolution, verification, and rollback remain. | [24](24-skill-and-prompt-ecosystem.md) |
| Prompt evaluation | Confirmed | Prompt loading/search exists; controlled evaluation and experiment tracking do not. | [24](24-skill-and-prompt-ecosystem.md) |
| Examples/templates | Partial | Examples and bundled prompts/skills exist; curated, maintained starter packs can expand. | [24](24-skill-and-prompt-ecosystem.md) |
| Benchmark transparency | Duplicate | Same outcome as public benchmark results. | [23](23-public-benchmark-transparency.md) |
| Distributed fleet | Confirmed, strategic | Fleet is sophisticated but local-process oriented. | [25](25-distributed-fleet.md) |
| Enterprise policy layer | Duplicate | Covered by governance assessment above. | [20](20-enterprise-governance.md) |
| Live collaboration | Duplicate | Covered by UI assessment above. | [26](26-live-cross-surface-collaboration.md) |
| Autonomous issue-to-PR | Confirmed | Building blocks exist, but no governed end-to-end async intake and PR pipeline is established. | [27](27-autonomous-issue-to-pr-pipeline.md) |

## Recommended investment balance

- **Near term:** roughly half of roadmap capacity should go to reliability, policy UX, MCP completion, and operational commands; these compound every later feature.
- **Middle term:** focus on browser, semantic memory, Desktop, API/data/deployment workflows, and benchmark publication.
- **Long term:** only fund distributed workers and live collaboration after identity, audit, security, and real usage data justify their operating complexity.
