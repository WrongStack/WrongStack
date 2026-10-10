---
name: astro-modern
description: "Build and upgrade Astro content sites and applications with deliberate islands, content contracts and rendering modes. Use when implementing Astro pages, content collections or on-demand routes; avoid hydrating the entire page for small interactions."
trigger: "Build and upgrade Astro content sites and applications with deliberate islands, content contracts and rendering modes. Use when implementing Astro pages, content collections or on-demand routes; avoid hydrating the entire page for small interactions."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: frontend
  domain: "web"
---

# Astro Modern

## Selection card
- Task: Astro content sites and islands.
- Start: Locate the affected route/component and its runtime/lockfile.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Build and upgrade Astro content sites and applications with deliberate islands, content contracts and rendering modes.

Checked 2026-10-09: Astro 7.3.8. Verify the current runtime/adapter and UI integration versions before install or migration.

## Rules

1. Decide static versus on-demand rendering from real data freshness and authentication needs.
2. Hydrate only interactive islands with the correct client directive and supported UI integration.
3. Keep content schemas and routes explicit; labels/demo claims must reflect actual supplied content.
4. Validate/authorize server actions/endpoints and isolate request-private data.
5. Verify asset paths, image/font handling, links and metadata in the emitted deployment shape.
6. Do not treat local development routing as proof that a static host or adapter supports the same behavior.

## Workflow

1. Inspect config, content model, islands and deployment adapter.
2. Resolve current compatible targets and implement the requested route/content flow.
3. Check generated/direct routes, navigation and interactive island states.
4. Validate content schemas, asset URLs, metadata and supported server behavior.
5. Build and exercise the actual preview/production adapter.

## Before returning

Rendering/hydration choices intentional; content/route contracts checked; emitted artifact and deployment behavior distinguished.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Astro docs](https://docs.astro.build/), [On-demand rendering](https://docs.astro.build/en/guides/on-demand-rendering/).

## Skills in scope

- design-craft — design craft contracts and verification.
- web-performance — measure and improve web loading, responsiveness and visual stability with browser traces and representative workloads.
- accessibility — implement and review accessible user interfaces with semantic controls, keyboard and focus behavior, readable content and assistive-technology checks.
- ci-cd — build and repair reproducible CI and deployment workflows with explicit artifacts, permissions and release gates.
