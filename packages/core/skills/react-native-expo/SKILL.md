---
name: react-native-expo
description: "React Native and Expo apps: Expo Router, EAS Build/Update, config plugins, native modules, Reanimated, app.json/eas.json and Metro. Use when building or fixing mobile screens, navigation and deep links, native module integration, dev builds, OTA updates or an Expo SDK upgrade; keep packages on a supported SDK matrix. Not for native-only apps (use swift-ios or kotlin-android) or store submission (use mobile-release)."
trigger: "Use when the change touches app.json/app.config.*, eas.json, metro.config.*, expo-router files, native modules or an Expo SDK upgrade."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: mobile
  domain: "mobile"
paths: ["eas.json", "metro.config.*"]
---

# React Native and Expo

## Selection card
- Task: Build or repair React Native/Expo screens, navigation, native integration and updates.
- Start: Read package.json, app.json or app.config.*, eas.json, the Expo SDK version and whether ios/ and android/ are generated or committed.
- Finish: `npx expo-doctor` is clean, type checks and tests pass, and the journey ran in a development or release build on a simulator or device (stated which).

## Overview

In Expo every change is either JavaScript (hot reload, OTA-updatable) or native (needs a new binary) — knowing which side of that line a change falls on decides how it is built, tested and shipped.
Checked 2026-11-02: React Native 0.88.1, Expo 58.0.22, Expo Router 58.0.29, Reanimated 4.7.1 and React Navigation 7.5.1. Expo SDK 58 bundles RN 0.88.0 and Reanimated 4.7.1; Expo Router 58.0.29 pins react-server-dom-webpack ~19.3.0 while standalone React is 19.3.1. Refresh the matrix before setup.
Package versions follow the SDK, not npm's latest tag.

## Rules

1. Add and upgrade packages with `npx expo install <package>` so versions match the SDK; fix drift with `npx expo install --check`.
2. If ios/ and android/ are generated (Continuous Native Generation), change native configuration only through app config and config plugins, then run `npx expo prebuild --clean`; hand edits are lost.
3. Native module changes need a development build (`expo-dev-client`); Expo Go cannot load custom native code.
4. An OTA update may only ship JavaScript compatible with the installed binary's runtime version; any native change requires a new build and a new runtime version.
5. Secrets never live in the app: `EXPO_PUBLIC_` variables are inlined into the bundle, and tokens go to `expo-secure-store`, not AsyncStorage.
6. Handle safe areas, keyboard, Android back, permission denial and cold-start deep links as normal product states.
7. Prove release behavior with a release build; Hermes bytecode, minification and `__DEV__` branches hide bugs in development.

## First moves by situation

| Situation | First moves |
|---|---|
| "Native module not found" / undefined in JS | Running in Expo Go or a stale dev build; rebuild with `npx expo run:ios` / `npx expo run:android` or an EAS development profile |
| Build breaks after adding a package | `npx expo-doctor`; check the package supports the New Architecture and the SDK; config plugin present in app config |
| SDK upgrade | Follow the SDK upgrade walkthrough one SDK at a time; `npx expo install expo@^<sdk>` then `npx expo install --fix`; regenerate native folders |
| OTA update crashed users | Compare the update's runtime version with the binary; roll back the update channel; adopt the fingerprint runtime-version policy |
| Deep link opens wrong screen or nothing | Check `scheme`, Expo Router file paths, `+not-found`, and for universal/app links the hosted association files |
| List scroll jank | `keyExtractor`, memoized `renderItem`, item layout hints; consider FlashList; profile in a release build |
| Animation stutters | Run animations on the UI thread with Reanimated shared values; avoid JS-thread `setState` per frame |
| Works in dev, broken in release | Build release locally (`npx expo run:android --variant release`, `npx expo run:ios --configuration Release`); check `__DEV__` branches and env inlining |

## Patterns and pitfalls

- **Expo Router layouts** — `_layout.tsx` defines the navigator; auth gating belongs in layouts (redirects or protected route groups) so deep links cannot bypass it.
- **Typed routes** — enable typed routes so `href` strings are checked; refactors otherwise break links silently.
- **New Architecture** — current React Native is built on the New Architecture; libraries without support are blockers, not warnings.
- **Reanimated 4** — worklets come from `react-native-worklets` with its Babel plugin, and it requires the New Architecture; check the migration notes when upgrading from Reanimated 3.
- **Keyboard** — `KeyboardAvoidingView` behaves differently per platform; test both, or use a keyboard-controller library the project already has.
- **Safe areas** — `useSafeAreaInsets` from `react-native-safe-area-context`; do not hard-code notch padding.
- **Images** — `expo-image` caches and decodes efficiently; size images to their rendered dimensions.
- **Permissions** — request in context, handle "denied" and "blocked" (needs Settings), and provide iOS usage strings through app config.
- **Updates channels** — map EAS build profiles to update channels deliberately; a preview channel must never receive production updates.
- **Metro** — custom resolvers and monorepo watch folders live in metro.config.*; clear the cache with `npx expo start --clear` after config changes.
- **Debugging** — React Native DevTools from the Metro terminal; native crashes need Xcode or `adb logcat` output, not JS logs.
- **Tests** — Jest with the `jest-expo` preset and React Native Testing Library for components; Maestro or Detox for end-to-end flows.

## Workflow

1. Identify SDK, architecture, CNG versus committed native folders, router setup and EAS profiles.
2. Classify the change: JavaScript-only or native (new module, permission, plugin, app config).
3. Implement with existing navigation and state patterns; add safe-area, keyboard, empty, error and offline states.
4. Run type checks and tests; then a development build for native changes.
5. Verify release behavior and deep links on simulator or device; plan OTA versus binary delivery.

## Proof

- Health: `npx expo-doctor` and `npx expo install --check`
- Types and tests: `npx tsc --noEmit` and `npx jest` (or the project scripts)
- Native config regenerated: `npx expo prebuild --clean` (when CNG is used) with the diff reviewed
- Development build: `npx expo run:ios` or `npx expo run:android`, or `eas build --profile development`
- Release build locally: `npx expo run:android --variant release` / `npx expo run:ios --configuration Release`
- Deep link: `npx uri-scheme open "<scheme>://path" --ios` (or `--android`)

## Stop and ask

- The change needs native code but the release plan assumes an OTA update.
- Ejecting from CNG, switching navigation libraries or upgrading more than one SDK at a time.
- EAS credentials, signing keys or store accounts are required.

## Before returning

- [ ] Expo SDK, React Native and library versions form the supported matrix (`expo-doctor` clean)
- [ ] Change classified as JavaScript or native; build and update plan match
- [ ] Native configuration expressed in app config or plugins when CNG is used
- [ ] No secrets in `EXPO_PUBLIC_` variables or AsyncStorage
- [ ] Safe areas, keyboard, back, permission denial and deep links handled
- [ ] Types and tests pass; release or development build exercised with device/simulator stated

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Expo SDK matrix](https://docs.expo.dev/versions/latest/), [Expo upgrade](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/), [React Native](https://reactnative.dev/docs/getting-started), [Continuous Native Generation](https://docs.expo.dev/workflow/continuous-native-generation/), [Runtime versions](https://docs.expo.dev/eas-update/runtime-versions/).

## Skills in scope

- mobile-design — native navigation patterns, safe-area insets, keyboard handling, and touch target sizing.
- mobile-performance — release-build frame timing, startup latency, and memory profiling on target devices.
- mobile-release — EAS / native code signing, runtime version alignment, and App Store / Play Store delivery.
- authentication-sessions — secure token storage, OAuth/passkey deep-link callbacks, and session rotation.
- react-modern — React component state, effects and hooks shared with the web.
