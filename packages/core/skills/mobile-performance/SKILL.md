---
name: mobile-performance
description: "Mobile app speed: slow cold start, scroll jank, frame drops, ANRs, memory leaks and battery drain, via Perfetto, Instruments, DevTools. Use when a React Native, Flutter, Android or iOS app starts slowly, stutters, leaks memory, drains battery or gets ANRs; compare release builds on real devices under matched conditions. Not for web pages (use web-performance) or feature work without a measured symptom."
trigger: "Use when a mobile app is slow to start, janks while scrolling or animating, leaks memory, triggers ANRs or drains battery."
version: 1.1.2
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: mobile
  domain: "mobile"
---

# Mobile Performance

## Selection card
- Task: Profile and fix mobile startup, frame pacing, memory and battery problems.
- Start: Reproduce the slow journey in a release or profile build on a named physical device and record a baseline trace.
- Finish: matched before/after measurements on the same device show the bottleneck moved, with sample counts and preserved behavior reported.

## Overview

Mobile performance work is valid only on release or profile builds on real devices: debug builds change every number, and simulators do not reproduce GPU, thermal or memory limits.
Use the current framework profiler and platform tools supported by the installed app/toolchain; latest framework targets are verified in the corresponding implementation skills.
Every fix starts from a trace that names the thread or layer responsible.

## Rules

1. Measure release or profile builds on a physical device; write down model, OS version, build, dataset, cold or warm start, charging and thermal state.
2. Localize before changing code: main/UI thread, JS or Dart thread, raster/GPU thread, native I/O, or memory pressure.
3. Measure the user journey: time to initial display, time to full display, frame times while scrolling, touch-to-response, heap after repeated navigation.
4. Take at least five runs per side and report median and p90; one fast run proves nothing.
5. Fix the dominant cost first; memoization or caching without a trace showing the cost is speculation.
6. Keep correctness, accessibility and visual fidelity in the acceptance check.

## First moves by situation

| Situation | First moves |
|---|---|
| Slow cold start (Android) | `adb shell am start -W -n <pkg>/<activity>` for TotalTime; Perfetto or Macrobenchmark startup trace; check `Application.onCreate`, content providers, DI graph |
| Slow cold start (iOS) | Instruments App Launch template; look at pre-main (dylibs) and work in `App.init`/first scene |
| Slow start (React Native) | Hermes enabled; measure bundle load and first render; defer non-critical modules with lazy requires |
| Scroll jank | Frame timeline: is the UI thread or raster thread over budget? Image decode size, heavy item layouts, non-recycled cells |
| ANR or frozen UI | Main-thread disk, network or lock waits in the ANR trace; StrictMode in debug on Android |
| Memory grows per navigation | Navigate in and out ten times, then capture a heap snapshot; look for retained screens, listeners, bitmaps; LeakCanary on Android |
| Animation stutters (RN) | Is the animation driven from JS? Move it to the UI thread (Reanimated or native driver) |
| Battery drain | Wake locks, high-accuracy location, polling timers, background work frequency; Android Battery Historian or Xcode Energy gauge |

## Patterns and pitfalls

- **TTFD signal** — call `reportFullyDrawn()` (Android) or emit a signpost when the screen is truly usable, otherwise tools only measure the first frame.
- **Baseline Profiles** — on Android they cut startup and early jank by precompiling hot paths; generate them with Macrobenchmark and verify they ship in the release build.
- **Image decoding** — decode at display size (`cacheWidth`/`cacheHeight` in Flutter, `expo-image` or sized sources in RN, downsampling on native); full-size decodes cause jank and OOM kills.
- **List virtualization** — recycled cells with stable keys and fixed or estimated item sizes; nested scroll views defeat virtualization.
- **JS thread budget** — in React Native, `console.log` in release, large JSON parsing and per-frame `setState` block the JS thread; strip logs and move work off-thread.
- **Flutter threads** — the DevTools frame chart separates UI (Dart build/layout) from raster (GPU); fix whichever bar exceeds the frame budget.
- **Overdraw and layers** — stacked opaque backgrounds and unnecessary offscreen layers cost GPU time; use the platform overdraw or layer debugging tools.
- **Startup work** — defer analytics, remote config and secondary database warm-up until after first interaction; parallelize independent init.
- **Thermal throttling** — repeated runs heat the device and slow it; cool down between runs or alternate before/after builds.
- **Emulators lie** — use them for functional checks only; frame and memory numbers come from devices.
- **Production telemetry** — slow and frozen frames, ANR and startup metrics from Play vitals, MetricKit or the crash/performance SDK confirm the fix reached users.

## Workflow

1. Reproduce in release/profile mode on a representative (often mid- or low-end) device.
2. Capture a trace and identify the dominant thread, task or allocation.
3. Make one narrow change.
4. Re-measure with the same device, build mode, data and run count; check correctness and accessibility.
5. Report sample counts, median and p90, conditions and trade-offs; add a benchmark or test that guards the gain when the project supports it.

## Proof

- Android startup: `adb shell am start -W -n <pkg>/<activity>` repeated, or a Macrobenchmark startup test
- Android frames: `adb shell dumpsys gfxinfo <pkg> framestats` after the journey; Perfetto trace for detail
- Android memory: `adb shell dumpsys meminfo <pkg>` before and after repeated navigation
- iOS: Instruments App Launch, Time Profiler, Hitches and Allocations; XCTest performance tests with launch and memory metrics
- Flutter: `flutter run --profile` with DevTools; `flutter run --profile --trace-startup` for startup timing
- React Native: the release build with the performance monitor and the Hermes sampling profiler

## Stop and ask

- Only debug-build or simulator numbers are available for a claim that will drive a product decision.
- The fix removes features, changes minimum OS versions or swaps core libraries.
- No representative device is available for a device-specific complaint.

## Before returning

- [ ] Baseline and post-change measured in release or profile mode on the same physical device
- [ ] Bottleneck localized to a thread or layer with trace evidence
- [ ] Repeated navigation checked for retained memory, listeners and bitmaps
- [ ] At least five samples per side; median and p90 reported with conditions
- [ ] Visual fidelity, accessibility and behavior preserved; simulator versus device limits stated

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[React Native performance](https://reactnative.dev/docs/performance), [Flutter performance](https://docs.flutter.dev/perf), [Android performance](https://developer.android.com/topic/performance), [Android app startup](https://developer.android.com/topic/performance/vitals/launch-time), [Apple performance](https://developer.apple.com/documentation/xcode/improving-your-app-s-performance).

## Skills in scope

- react-native-expo — Fabric/TurboModule rendering, Reanimated worklets, and FlashList optimization.
- flutter-mobile — Impeller rasterization, isolate offloading, and widget rebuild scoping.
- swift-ios — Instruments (Time Profiler, Allocations, Core Animation hitches) and `@MainActor` latency.
- kotlin-android — Macrobenchmark, Baseline Profiles, Perfetto traces, and Compose recomposition counts.
- observability — production startup, ANR/crash-free rate, and slow/frozen frame telemetry.
