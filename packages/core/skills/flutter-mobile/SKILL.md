---
name: flutter-mobile
description: "Build and upgrade Flutter applications with typed state, navigation, platform plugins and device verification. Use when implementing Flutter screens or resolving Flutter/Dart integration; distinguish stable SDK releases from future branch schedules."
trigger: "Build and upgrade Flutter applications with typed state, navigation, platform plugins and device verification. Use when implementing Flutter screens or resolving Flutter/Dart integration; distinguish stable SDK releases from future branch schedules."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: mobile
  domain: "mobile"
---

# Flutter Mobile

## Selection card
- Task: Build Flutter widgets, state and platform integration.
- Start: Identify the platform, screen, device and native integration boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Build and upgrade Flutter applications with typed state, navigation, platform plugins and device verification.

Confirmed stable release target: Flutter 3.47.5. The archive machine-readable endpoint was unavailable during this check; re-resolve the latest stable patch before installation. Use its bundled Dart SDK, not an independently guessed Dart upgrade. Refresh the official stable archive before installation; future Flutter 3.50 scheduling is not a released stable target.

## Rules

1. Inspect pubspec, lockfile, analysis rules, SDK pin and native platform configuration.
2. Match plugin support and native build requirements to the chosen Flutter stable release.
3. Keep build methods pure; scope controllers, streams and subscriptions to their owner and dispose them.
4. Model loading/error/success state explicitly and prevent stale async completion after navigation/disposal.
5. Use constraints and semantic widgets rather than pixel assumptions across phone/tablet/desktop sizes.
6. Treat platform channels as validated contracts with bounded errors/cancellation; do not hide native failures behind generic success.

## Workflow

1. Read official migration notes and inspect the project's state/navigation pattern.
2. Implement the feature with existing widgets/theme and typed models.
3. Exercise long content, keyboard, back navigation, permission denial and app resume.
4. Run configured analyze/tests, widget/golden checks where relevant and platform builds.
5. Verify the actual device journey and report build/runtime limitations.

## Before returning

Stable SDK and bundled Dart recorded; plugin/native compatibility checked; lifecycle cleanup verified; release-device evidence scoped honestly.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Stable SDK archive](https://docs.flutter.dev/install/archive), [Confirmed release tag](https://flutter.googlesource.com/mirrors/flutter/+/refs/tags/3.47.5), [Flutter testing](https://docs.flutter.dev/testing).

## Skills in scope

- mobile-design — native navigation, insets and touch adaptation.
- mobile-performance — release-device profiling.
- mobile-release — signed artifact and store delivery.
- offline-sync — restart-safe local/server reconciliation.
