---
name: mobile-release
description: "Mobile release: iOS/Android signing, build numbers, TestFlight, Play tracks, EAS Build/Submit, .ipa/.aab, privacy manifests, rollout. Use when preparing, debugging or verifying a signed mobile build, store upload, review rejection or rollout; report build, upload, review and live states separately. Not for app feature code (use the platform skill) or web deploys (use release-rollback)."
trigger: "Use when a task involves signing, provisioning, keystores, versionCode/CFBundleVersion, TestFlight, Play Console tracks, eas build/submit or a store rejection."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: mobile
  domain: "mobile"
---

# Mobile Release

## Selection card
- Task: Prepare, verify and (when authorized) submit signed mobile releases.
- Start: Read the release configuration (Xcode scheme and signing, Gradle signingConfigs, eas.json profiles), the current version and build numbers and the store state of the last release.
- Finish: the signed artifact was inspected and exercised, and build, upload, review and live states are reported separately with version, build number and commit.

## Overview

A mobile release cannot be recalled from users' devices, so every release needs a strictly increasing build number, verified entitlements and privacy declarations, archived crash symbols, and a written answer to "how do we stop this if it is bad".
Refresh current Apple/Google submission requirements, framework SDK support and signing tooling before each release. Read [iOS delivery](references/ios.md) or [Android delivery](references/android.md) for the selected platform.

## Rules

1. A local or CI build never authorizes a store upload, review submission or production rollout; do those only when the task explicitly asks.
2. Signing certificates, provisioning profiles, keystores and store API keys stay in the vault or CI secret store; never in the repository, logs or chat.
3. Build numbers (`CFBundleVersion`, `versionCode`) strictly increase per upload; marketing versions follow the project's scheme.
4. Build the exact production configuration and inspect it: bundle/application id, entitlements, permissions and purpose strings, privacy manifest, target SDK, production endpoints.
5. Test upgrade-over-previous-version on a device: storage migrations, keychain/keystore data, deep links, push registration.
6. Archive dSYMs, R8 mapping files and JS source maps with the build identifier before release.
7. OTA updates must match the binary's runtime version; native, entitlement or permission changes always need a new binary.

## First moves by situation

| Situation | First moves |
|---|---|
| Upload rejected for build number | Read the highest uploaded build in App Store Connect or Play Console; bump and rebuild; automate increment in CI |
| iOS signing error | Team id, bundle id and profile match; certificate valid and in the keychain; entitlements match the profile's capabilities |
| Android "upload key mismatch" | You signed with the wrong key; Play App Signing holds the app key, you upload with the upload key; reset the upload key through Play support if lost |
| App review rejection | Quote the guideline cited; check purpose strings, privacy manifest, account deletion, sign-in requirements and demo credentials |
| Release-only crash | R8 keep rules or Hermes/minification; reproduce with the signed release build and symbolicate with archived symbols |
| App links stop opening the app | assetlinks.json fingerprint must be the Play app-signing certificate; apple-app-site-association served correctly with the right app id |
| Bad release already rolling out | Halt the staged rollout or phased release; prepare a forward fix with a higher build number; roll back OTA channel if applicable |

## Patterns and pitfalls

- **Four states** — built, uploaded and processed, review approved, live (with rollout percentage); never report one as another.
- **Staged rollouts** — Play staged rollout and App Store phased release limit blast radius; watch crash-free rate before increasing.
- **No downgrade** — users cannot install a lower build number; rollback means halting and shipping a higher build from known-good code with backward-compatible storage.
- **Privacy manifests** — third-party SDKs need their own manifests; required-reason APIs must be declared or uploads are flagged.
- **Export compliance** — declare encryption usage in Info.plist so TestFlight builds do not wait for a manual answer.
- **Target SDK deadlines** — Google Play requires a recent target API for updates; check the current deadline well before release.
- **Merged manifest** — libraries add permissions; inspect the merged Android manifest, not just yours.
- **EAS profiles** — the profile decides channel, environment variables and credentials; building with the preview profile and submitting it as production is a common mistake.
- **Symbols** — without dSYMs, mapping files and source maps, production crashes are unreadable; upload them where the crash tool expects them.

## Workflow

1. Confirm what the task authorizes: build only, internal/TestFlight distribution, store submission or rollout change.
2. Read release configuration and store state; decide versions and build numbers.
3. Build the production configuration (locally, CI or EAS) and inspect the artifact.
4. Exercise the signed build on a device, including upgrade over the previous release.
5. Distribute or submit through the requested channel only, and record the resulting state.
6. Record artifacts, symbols, commit, and the halt/rollback path.

## Proof

- iOS archive: `xcodebuild archive -scheme <App> -configuration Release -archivePath build/App.xcarchive`, then export with an explicit `ExportOptions.plist`
- iOS inspection: `codesign -d --entitlements :- <App.app>` and the Info.plist version keys
- Android bundle: `./gradlew bundleRelease`; inspect with `bundletool dump manifest --bundle app-release.aab`
- Android signature: `apksigner verify --print-certs app-release.apk` (for APKs built from the bundle)
- Expo: `eas build --platform all --profile production` and `eas submit` only when submission is authorized
- Device test: install the release artifact over the previous production version and run the primary journey

## Stop and ask

- The task did not explicitly ask for upload, submission or rollout change.
- Signing material is missing, expired or would need to be regenerated or reset.
- A store policy, privacy or export-compliance declaration needs a legal or business answer.
- The release contains a storage migration that cannot be undone.

## Before returning

- [ ] Bundle/application id, marketing version, build number and commit recorded
- [ ] Signing material kept out of source, logs and output
- [ ] Entitlements, permissions with purpose strings, privacy manifest and target SDK verified in the artifact
- [ ] Signed build exercised on a device, including upgrade over the previous release and deep links
- [ ] dSYMs, mapping files and source maps archived with the build
- [ ] Built, uploaded, review and live states reported separately, with the halt/rollback path

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Expo production builds](https://docs.expo.dev/build/introduction/), [App Store submission](https://developer.apple.com/app-store/submitting/), [Android release](https://developer.android.com/studio/publish), [Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756).

## Skills in scope

- react-native-expo — EAS Build profiles, `runtimeVersion` policies, and config plugin native generation.
- flutter-mobile — Flutter release flavors (`--release`, `--obfuscate`, `--split-debug-info`) and platform runner configuration.
- swift-ios — Xcode schemes, entitlements and Info.plist keys.
- kotlin-android — Gradle signing configs, R8 rules and variants.
- ci-cd — automated signing workflows, artifact provenance, and release approval gates.
- release-rollback — staged store rollout halts, compatible API versioning, and OTA rollback boundaries.
