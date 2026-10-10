---
name: mobile-performance
description: "Measure and improve mobile startup, scrolling, animation and resource usage on representative devices. Use when diagnosing React Native/Flutter/native performance; compare release builds under matched conditions rather than promising a universal frame rate."
trigger: "Measure and improve mobile startup, scrolling, animation and resource usage on representative devices. Use when diagnosing React Native/Flutter/native performance; compare release builds under matched conditions rather than promising a universal frame rate."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: mobile
  domain: "mobile"
---

# Mobile Performance

## Selection card
- Task: Profile device startup, scrolling and memory.
- Start: Identify the platform, screen, device and native integration boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Measure and improve mobile startup, scrolling, animation and resource usage on representative devices.

Use the current framework profiler and platform tools supported by the installed app/toolchain; latest framework targets are verified in the corresponding implementation skills.

## Rules

1. Record device, OS, app build, dataset, thermal/battery state and cold/warm conditions.
2. Separate JS/Dart/UI/render/native work before choosing an optimization.
3. Measure the real task: startup readiness, input latency, list scroll and memory across repeated navigation.
4. Virtualize large collections and stabilize unnecessary render work only where a trace identifies cost.
5. Dispose owned subscriptions/controllers/media/GPU resources; a lower initial heap does not prove leaks are fixed.
6. Avoid debug-mode comparisons for production claims and keep accessibility/visual correctness in the acceptance check.

## Workflow

1. Reproduce the slow journey in a release/profile build.
2. Capture profiler evidence and identify the dominant frame/task/resource bottleneck.
3. Make a narrow change and repeat matched measurements with multiple samples.
4. Test low-resource and lifecycle conditions relevant to the product.
5. Report sample counts, distribution, conditions, behavior checks and tradeoffs.

## Before returning

Before/after conditions match; bottleneck backed by trace; performance and correctness rechecked; emulator evidence separated from physical device results.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[React Native performance](https://reactnative.dev/docs/performance), [Flutter performance](https://docs.flutter.dev/perf), [Android performance](https://developer.android.com/topic/performance).

## Skills in scope

- react-native-expo — React Native/Expo platform integration.
- flutter-mobile — Flutter lifecycle and platform integration.
- swift-ios — native Swift actor/lifecycle behavior.
- kotlin-android — native Android coroutine/lifecycle behavior.
- observability — runtime signals and correlation.
