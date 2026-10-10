---
name: kotlin-android
description: "Build and upgrade native Android applications with Kotlin, Compose/View UI and lifecycle-aware work. Use when implementing Android screens, navigation, permissions or background jobs; coordinate Kotlin, Gradle, AGP and SDK compatibility."
trigger: "Build and upgrade native Android applications with Kotlin, Compose/View UI and lifecycle-aware work. Use when implementing Android screens, navigation, permissions or background jobs; coordinate Kotlin, Gradle, AGP and SDK compatibility."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: mobile
  domain: "mobile"
---

# Kotlin Android

## Selection card
- Task: Build Kotlin Android and Jetpack Compose features.
- Start: Identify the platform, screen, device and native integration boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Build and upgrade native Android applications with Kotlin, Compose/View UI and lifecycle-aware work.

Checked 2026-10-09: Kotlin 2.4.21 and Gradle 9.8.1. Verify current AGP/Compose/compiler/JDK and Android SDK matrix; independently latest versions may not form a supported build.

## Rules

1. Inspect build plugins/catalogs, SDK levels, app id, manifests and signing variants.
2. Scope coroutines/flows to the correct lifecycle and use structured cancellation.
3. Keep UI state observable and ownership explicit; recomposition is not permission to start duplicate side effects.
4. Handle permission denial, process recreation, background restrictions and saved state as real product states.
5. Match Android back/navigation, insets, large screens and accessibility.
6. Store sensitive app credentials in supported mechanisms and authorize data operations on the server.

## Workflow

1. Trace screen/ViewModel/repository and current UI/data conventions.
2. Verify the stable supported build-tool/SDK combination and migration steps.
3. Implement lifecycle-owned work and visible states.
4. Test process/lifecycle transitions, navigation, permissions and window sizes.
5. Run configured lint/tests/build and verify the app on a representative device.

## Before returning

Tool/SDK matrix clear; coroutine/state lifecycle checked; device behavior and signing/release proof separated.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Kotlin releases](https://github.com/JetBrains/kotlin/releases), [Android architecture](https://developer.android.com/topic/architecture), [Android build](https://developer.android.com/build).

## Skills in scope

- mobile-design — design and implement mobile interfaces for touch, keyboards, safe areas and native navigation.
- mobile-performance — measure and improve mobile startup, scrolling, animation and resource usage on representative devices.
- mobile-release — prepare and verify signed mobile releases, test-channel distribution and store submission artifacts.
- offline-sync — implement offline-capable applications with local persistence, queued changes and explicit synchronization conflicts.
