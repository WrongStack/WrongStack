---
name: go-services
description: "Build and upgrade Go services, workers and CLI applications with context propagation and explicit ownership. Use when implementing Go HTTP/data/concurrency paths; preserve module and deployment constraints and verify race-sensitive behavior deterministically."
trigger: "Build and upgrade Go services, workers and CLI applications with context propagation and explicit ownership. Use when implementing Go HTTP/data/concurrency paths; preserve module and deployment constraints and verify race-sensitive behavior deterministically."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "backend"
---

# Go Services

## Selection card
- Task: Build Go handlers, concurrency and cancellation.
- Start: Locate the endpoint, schema, authentication boundary and caller.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Build and upgrade Go services, workers and CLI applications with context propagation and explicit ownership.

Checked stable Go target: 1.27.2 on 2026-10-09. Inspect go.mod/toolchain, dependencies and actual compiler before using release-specific APIs.

## Rules

1. Propagate context deadlines/cancellation through owned I/O and goroutines.
2. Define channel/goroutine ownership: who closes, who waits and how work stops.
3. Bound concurrency and output; one goroutine per unbounded item is not a resource policy.
4. Check errors at the operation boundary and release files/connections/response bodies on every path.
5. Protect shared state according to access patterns; copied structs can still share maps/slices/pointers.
6. Distinguish compile success from data races and lifecycle correctness.

## Workflow

1. Inspect modules, entrypoint, existing interfaces and tests.
2. Verify current toolchain target and dependency support.
3. Implement the narrow path with context and cleanup contracts.
4. Use controlled completion ordering for lifecycle/race cases; run the configured race detector where applicable.
5. Run project format/vet/test/build and exercise the actual command/service.

## Before returning

Context and resource ownership explicit; failure/stop paths checked; toolchain, race/test/build results reported separately.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Go releases](https://go.dev/dl/?mode=json), [Go documentation](https://go.dev/doc/).

## Skills in scope

- api-design — api design contracts and verification.
- observability — observability contracts and verification.
- testing — testing contracts and verification.
- docker-deploy — docker deploy contracts and verification.
