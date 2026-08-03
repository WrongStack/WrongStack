# WrongStack Competitive Roadmap 2026–2027

## Purpose

This folder turns the gap assessment in [00-gap-assessment.md](00-gap-assessment.md) into implementation-oriented plans. Each capability has its own file so it can be estimated, assigned, revised, and delivered independently.

This is a planning baseline, not a release commitment. Every plan must be revalidated against the live codebase before implementation.

The detailed source-to-roadmap classification is in [Gap assessment](00-gap-assessment.md).

## Validation corrections

The source report is useful, but several statements no longer describe the repository accurately:

- Sage is already the default memory store across CLI, TUI, WebUI, SimpleUI, and Desktop. The remaining opportunity is semantic retrieval and stronger continuity, not default wiring.
- `/security` is implemented and registered. The remaining slash-command gap is operational parity for `/git`, `/health`, `/metrics`, and `/plan`.
- WrongStack already accepts vision-capable model input. The remaining media gap is normalized OCR, generation, transformation, and artifact handling.
- Browser use is available through a Playwright MCP preset and browser-agent instructions. The gap is a dependable first-party browser capability with lifecycle, policy, and cross-surface parity.
- HQ already has live telemetry, persistence, alerts, command history, and a React dashboard. Its remaining work is security hardening and operational polish.
- CI already runs on Ubuntu and Windows. Cross-platform quality work should extend this baseline rather than introduce a second matrix.
- A generic `test` tool and Playwright tests already exist. The gap is browser-aware orchestration, evidence capture, and broader surface coverage.

## Prioritization model

- **P0 — Foundation:** closes a current usability, protocol, or trust gap and unblocks later initiatives.
- **P1 — Differentiation:** materially improves daily workflows or product competitiveness.
- **P2 — Expansion:** broadens the addressable market after the foundations are stable.
- **P3 — Strategic:** high-leverage, high-complexity work that requires validated demand.

## Roadmap

| ID | Capability | Priority | Horizon | Primary dependency |
|---|---|---:|---|---|
| 01 | [Operational slash commands](01-operational-slash-commands.md) | P0 | 0–3 months | Existing CLI services |
| 02 | [First-party browser automation](02-first-party-browser-automation.md) | P0 | 0–3 months | Tool lifecycle and permissions |
| 03 | [Browser-aware E2E runner](03-browser-aware-e2e-runner.md) | P1 | 3–6 months | 02 |
| 04 | [Database tooling](04-database-tooling.md) | P1 | 3–6 months | Secret vault and policy scopes |
| 05 | [API contract testing](05-api-contract-testing.md) | P1 | 3–6 months | Fetch/tool streaming primitives |
| 06 | [Multimodal media workflows](06-multimodal-media-workflows.md) | P1 | 3–6 months | Provider capability model |
| 07 | [Deployment, cloud, and IaC workflows](07-deployment-cloud-iac-workflows.md) | P1 | 4–9 months | Governance and audit controls |
| 08 | [MCP resources and prompts](08-mcp-resources-and-prompts.md) | P0 | 0–3 months | MCP capability negotiation |
| 09 | [MCP authentication and sampling](09-mcp-authentication-and-sampling.md) | P1 | 3–6 months | 08 and Brain/permission policy |
| 10 | [MCP rich content](10-mcp-rich-content.md) | P1 | 2–5 months | Attachment/artifact model |
| 11 | [MCP registry and installation](11-mcp-registry-and-installation.md) | P2 | 6–12 months | Secure package metadata |
| 12 | [MCP health and operations](12-mcp-health-and-operations.md) | P0 | 0–3 months | Metrics and Health registries |
| 13 | [Semantic Sage retrieval](13-semantic-Sage-retrieval.md) | P0 | 0–4 months | Embedding provider abstraction |
| 14 | [Cross-session continuity and project state](14-cross-session-continuity-and-project-state.md) | P1 | 3–7 months | 13 and session invariants |
| 15 | [Desktop distribution](15-desktop-distribution.md) | P1 | 3–6 months | WebUI parity and release signing |
| 16 | [HQ hardening and operations](16-hq-hardening-and-operations.md) | P0 | 0–3 months | Existing HQ Phase 7 |
| 17 | [Responsive WebUI](17-responsive-webui.md) | P1 | 2–5 months | WebUI design tokens |
| 18 | [Rich TUI rendering](18-rich-tui-rendering.md) | P1 | 3–6 months | Ink renderer boundaries |
| 19 | [Policy authoring experience](19-policy-authoring-experience.md) | P0 | 1–4 months | Permission policy schema |
| 20 | [Enterprise governance](20-enterprise-governance.md) | P2 | 6–12 months | 19 and identity model |
| 21 | [Brain evaluation and replay](21-brain-evaluation-and-replay.md) | P0 | 1–4 months | Brain decision telemetry |
| 22 | [Quality engineering program](22-quality-engineering-program.md) | P0 | Continuous | CI and surface harnesses |
| 23 | [Public benchmark transparency](23-public-benchmark-transparency.md) | P1 | 2–6 months | Existing bench harness |
| 24 | [Skill and prompt ecosystem](24-skill-and-prompt-ecosystem.md) | P2 | 6–12 months | Registry trust model |
| 25 | [Distributed fleet](25-distributed-fleet.md) | P3 | 9–18 months | Enterprise identity and transport |
| 26 | [Live cross-surface collaboration](26-live-cross-surface-collaboration.md) | P3 | 9–18 months | Shared state protocol |
| 27 | [Autonomous issue-to-PR pipeline](27-autonomous-issue-to-pr-pipeline.md) | P2 | 6–12 months | Git hosting integration and fleet |

## Recommended sequence

1. Deliver the trust and protocol foundations: 01, 08, 12, 16, 19, 21, and the first slice of 22.
2. Add high-frequency capabilities: 02, 10, 13, 15, 17, and 23.
3. Build workflow depth: 03–07, 09, 14, and 18.
4. Expand the ecosystem and enterprise surface: 11, 20, 24, and 27.
5. Start 25 and 26 only after demand, security boundaries, and operating costs are validated.

## Program rules

- Preserve `core` dependency direction; surface packages compose capabilities above the kernel.
- Every mutating tool must use the existing permission policy, cancellation contract, progress events, and audit path.
- Prefer MCP for vendor-specific integrations, but keep a stable WrongStack capability contract so workflows are portable.
- New config fields are denied in project config by default and must be classified explicitly.
- Each implementation PR needs tests, docs, migration notes where applicable, and an explicit rollback path.
- Public benchmark claims must include harness fingerprints, model/provider settings, cost, date, and reproducible inputs.

## Completion discipline

When an initiative ships, update its status and acceptance criteria in place, add links to the implementation/tests, and move any remaining work into a smaller follow-up plan. Do not leave a shipped capability described as a current gap.
