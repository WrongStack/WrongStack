---
name: web-performance
version: 1.0.1
description: "Measure and improve web loading, responsiveness and visual stability with browser traces and representative workloads. Use when diagnosing Core Web Vitals, slow routes, bundle growth, long tasks or animation jank; preserve functionality and compare matched before/after conditions."
trigger: "diagnosing Core Web Vitals, slow routes, bundle growth, long tasks or animation jank; preserve functionality and compare matched before/after conditions."
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
metadata:
  routing-group: frontend
---

# Web Performance

## Selection card
- Task: Measure and improve browser loading and interaction.
- Start: Locate the affected route/component and its runtime/lockfile.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Optimize the measured bottleneck. Current Core Web Vitals are LCP, INP and CLS;
good thresholds are at most 2.5 seconds, 200 milliseconds and 0.1 respectively
at the 75th percentile. Field evidence and local lab runs answer different questions.

## Rules

1. Record route, commit/input state, build mode, device, network, cache and data.
   Development-server measurements are not production performance.
2. Trace the user's critical task before proposing changes. Separate network,
   server, main-thread, layout and rendering delay.
3. Prioritize the LCP resource, input blocking and unexpected layout shifts.
   Do not optimize a Lighthouse score while making the real interaction worse.
4. Compare equivalent conditions with repeated measurements. Report distributions
   and variability rather than a best run or invented percentage.
5. Keep analytics labels bounded and sensitive data out of performance telemetry.
6. Set budgets from product/device needs and an observed baseline. Avoid one
   universal bundle-size or fps mandate.

## Workflow

1. Build/run production and exercise a representative cold/warm user journey.
   Gather browser traces, network waterfall and available field metrics.
2. Identify the largest bottleneck with file/resource/call-stack evidence.
3. Apply a narrow change: resource priority, image sizing, route splitting,
   caching, rendering work or long-task decomposition as indicated.
4. Test the interaction, responsive behavior and accessibility after optimization.
5. Repeat the same measurement and report sample count, conditions, results
   and tradeoffs. Run affected build/tests.

## Sources

[Web Vitals](https://web.dev/articles/vitals), reviewed 2026-10-09.
Refresh thresholds and measurement tooling before consequential claims.

## Acceptance checks

- Compare the same route and conditions before/after; verify observed user-visible improvement.

## Skills in scope

- observability — field metrics and diagnostics.
- nextjs-modern — framework rendering/caching.
- motion-design — animated interaction cost.
- threejs-3d — canvas and asset profiling.
