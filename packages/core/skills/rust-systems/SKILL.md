---
name: rust-systems
description: "Build and upgrade Rust services, CLI and systems components with explicit error, async and resource contracts. Use when working on Rust ownership, concurrency, serialization or unsafe boundaries; preserve MSRV and edition compatibility unless their migration is requested."
trigger: "Build and upgrade Rust services, CLI and systems components with explicit error, async and resource contracts. Use when working on Rust ownership, concurrency, serialization or unsafe boundaries; preserve MSRV and edition compatibility unless their migration is requested."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "backend"
---

# Rust Systems

## Selection card
- Task: Implement Rust ownership, error and async boundaries.
- Start: Locate the endpoint, schema, authentication boundary and caller.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Build and upgrade Rust services, CLI and systems components with explicit error, async and resource contracts.

Checked stable Rust target: 1.99.0 on 2026-10-09. Verify rust-version, edition, workspace/toolchain pins and crate support before upgrading.

## Rules

1. Model errors and finite states explicitly; avoid panics for ordinary input/I/O failures.
2. Preserve borrowing/ownership invariants at async and callback boundaries, not merely compiler acceptance.
3. Bound task concurrency and blocking work; use the existing runtime scheduling and cancellation model.
4. Check serialization/input at trust boundaries and separate private state from public output.
5. For unsafe code, document the exact safety invariant and inspect each caller; no blanket safety comments.
6. Drop/release behavior and persistent data recovery are separate; RAII does not guarantee a successful external commit.

## Workflow

1. Inspect workspace, features, toolchain/MSRV and current crate APIs.
2. Verify latest compatible stable targets and migration deltas.
3. Implement the feature with typed states and clear ownership.
4. Test error/cancel/restart behavior and boundary inputs; use configured sanitizers/Miri where relevant.
5. Run fmt/clippy/test/build through project commands and validate the deliverable.

## Before returning

Toolchain/MSRV changes explicit; ownership/error contracts checked; unsafe claims supported; actual tests/build reported.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Rust stable manifest](https://static.rust-lang.org/dist/channel-rust-stable.toml), [Rust book](https://doc.rust-lang.org/book/).

## Skills in scope

- api-design — api design contracts and verification.
- testing — testing contracts and verification.
- observability — observability contracts and verification.
- docker-deploy — docker deploy contracts and verification.
