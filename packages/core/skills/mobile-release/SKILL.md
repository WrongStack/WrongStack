---
name: mobile-release
description: "Prepare and verify signed mobile releases, test-channel distribution and store submission artifacts. Use when configuring iOS/Android signing, build variants or release delivery; distinguish build success, upload, review approval and live availability."
trigger: "Prepare and verify signed mobile releases, test-channel distribution and store submission artifacts. Use when configuring iOS/Android signing, build variants or release delivery; distinguish build success, upload, review approval and live availability."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: mobile
  domain: "mobile"
---

# Mobile Release

## Selection card
- Task: Prepare mobile signing and app-store releases.
- Start: Identify the platform, screen, device and native integration boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Prepare and verify signed mobile releases, test-channel distribution and store submission artifacts.

Refresh current Apple/Google submission requirements, framework SDK support and signing tooling before each release. Read [iOS delivery](references/ios.md) or [Android delivery](references/android.md) for the selected platform.

## Rules

1. Pin bundle/application id, version/build number, environment, source revision and native runtime compatibility.
2. Keep signing material and upload credentials in the approved vault/CI mechanism; never write them into source or logs.
3. Build the exact production configuration and inspect entitlements/permissions, endpoints and embedded assets.
4. Verify upgrade/install behavior, deep links and the primary journey in the signed build.
5. OTA updates must match the supported native runtime and store policy; they cannot supply a missing native module.
6. Publish or submit only within the authorized release task; a package build does not authorize a store upload.

## Workflow

1. Inspect the platform release configuration and current account/environment boundary.
2. Check SDK/store requirements and prepare deterministic version/signing inputs.
3. Build, inspect and test the signed artifact through the appropriate platform path.
4. Use the requested test/submission channel and record actual upload/review state.
5. Verify distribution availability separately and preserve rollback/recovery information.

## Before returning

Artifact/source/version identity recorded; signed build tested; secrets excluded; upload/review/live states reported separately.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Expo production builds](https://docs.expo.dev/build/introduction/), [App Store submission](https://developer.apple.com/app-store/submitting/), [Android release](https://developer.android.com/studio/publish).

## Skills in scope

- react-native-expo — React Native/Expo platform integration.
- flutter-mobile — Flutter lifecycle and platform integration.
- ci-cd — reproducible artifact and hosted pipeline checks.
- release-rollback — version promotion and recovery compatibility.
