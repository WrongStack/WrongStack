---
name: react-native-expo
description: "Build and upgrade React Native or Expo applications with navigation, native modules and verified platform integration. Use when implementing mobile screens, Expo Router flows or device capabilities; choose a supported SDK combination rather than forcing independent latest packages together."
trigger: "Build and upgrade React Native or Expo applications with navigation, native modules and verified platform integration. Use when implementing mobile screens, Expo Router flows or device capabilities; choose a supported SDK combination rather than forcing independent latest packages together."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: mobile
  domain: "mobile"
---

# React Native Expo

## Selection card
- Task: Build React Native and Expo app screens.
- Start: Identify the platform, screen, device and native integration boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Build and upgrade React Native or Expo applications with navigation, native modules and verified platform integration.

Checked 2026-10-09: React Native 0.87.1, Expo 57.0.27 and Expo Router 57.0.25. Expo SDK 57 documents RN 0.86 and React 19.2.3; independent React 19.3.0/RN 0.87.1 are newer. Refresh the matrix before setup.

## Rules

1. Identify Expo-managed/prebuild/bare workflow, installed SDK and generated native directories.
2. For latest independent React/RN targets, use a verified bare combination when Expo support lags. For Expo, report its supported matrix explicitly; do not silently downgrade or suppress dependency checks.
3. Install native dependencies through the project's Expo-compatible flow when appropriate; inspect config plugins and generated native changes.
4. Keep navigation, deep links, auth redirects and back behavior consistent across cold/warm launches.
5. Request device permissions at the actual feature boundary and handle denial/revocation without a crash.
6. Keep credentials in supported secure storage and server authorization at the server; an app bundle is publicly inspectable.

## Workflow

1. Inspect app config, lockfile, navigation and native integration before choosing versions.
2. Verify the current SDK/runtime/peer matrix and implement the narrow feature or upgrade group.
3. Exercise loading/error states, keyboard, safe area and lifecycle transitions.
4. Test device integration in an actual development/release build; Expo Go may not contain the needed native module.
5. Run configured lint/type/tests, platform build and the primary device journey.

## Before returning

SDK compatibility/blockers visible; native generation changes reviewed; platform/device checks recorded; simulator or JS-only evidence not presented as release proof.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Expo SDK matrix](https://docs.expo.dev/versions/latest/), [Expo upgrade](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/), [React Native](https://reactnative.dev/docs/getting-started).

## Skills in scope

- mobile-design — native navigation, insets and touch adaptation.
- mobile-performance — release-device profiling.
- mobile-release — signed artifact and store delivery.
- authentication-sessions — account/session authorization and renewal.
