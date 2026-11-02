---
name: kotlin-android
description: "Native Android with Kotlin: Jetpack Compose, ViewModel/StateFlow, coroutines, Room, WorkManager, Hilt, Gradle/AGP and AndroidManifest. Use when building or fixing Android screens, navigation, permissions, background work, release-only crashes or Kotlin/AGP/SDK upgrades. Not for Flutter or React Native (use flutter-mobile or react-native-expo) or store submission (use mobile-release)."
trigger: "Use when the change touches Kotlin Android sources, Compose UI, AndroidManifest.xml, Gradle build files or libs.versions.toml."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: mobile
  domain: "mobile"
paths: ["AndroidManifest.xml"]
---

# Kotlin Android

## Selection card
- Task: Build or repair Kotlin Android features with Compose, lifecycle-aware state and background work.
- Start: Read libs.versions.toml, the app and root Gradle files, AndroidManifest.xml and the screen's ViewModel and composables.
- Finish: unit tests, lint and the release-variant build pass, and the journey survives rotation and process death on an emulator or device (stated which).

## Overview

Android kills and recreates your process and activity at will, so the expert stance is: UI is a function of a `StateFlow` held by a ViewModel, anything the user typed or navigated to survives through `SavedStateHandle`, and all work is owned by a lifecycle-aware scope.
Checked 2026-11-02: Kotlin 2.4.21 and Gradle 9.8.2. Verify current AGP/Compose/compiler/JDK and Android SDK matrix; independently latest versions may not form a supported build.
Since Kotlin 2.0 the Compose compiler ships as a Kotlin compiler plugin whose version follows Kotlin; there is no separate Compose compiler version to pin.

## Rules

1. Never swallow `CancellationException`: a broad `catch (e: Exception)` in suspend code must rethrow it, or use `ensureActive()`; prefer `runCatching` only outside coroutines.
2. Collect flows in Compose with `collectAsStateWithLifecycle()`; start side effects only in `LaunchedEffect`/`DisposableEffect` keyed on what they depend on.
3. Expose immutable UI state (`StateFlow<UiState>`) from the ViewModel; model one-off results as state the UI acknowledges rather than fire-and-forget events that can be lost.
4. Persist user input and navigation keys with `SavedStateHandle` or `rememberSaveable`; ViewModel memory does not survive process death.
5. Upgrade Kotlin, AGP, Gradle, JDK and `compileSdk`/`targetSdk` as a verified matrix; each `targetSdk` bump changes runtime behavior and needs its behavior-changes page read.
6. Background work goes through WorkManager or a correctly typed foreground service; respect Doze, exact-alarm and foreground-service restrictions.
7. Secrets and tokens live in Keystore-backed storage; the server authorizes every data operation.

## First moves by situation

| Situation | First moves |
|---|---|
| Crash only in release builds | R8 removed or renamed something used reflectively (JSON adapters, enums, DI); read the mapping and add targeted keep rules; test `assembleRelease` locally |
| State lost after returning to the app | Simulate process death (background the app, `adb shell am kill <package>`), then reopen; move state into `SavedStateHandle` |
| Composable recomposes constantly | Layout Inspector recomposition counts; unstable parameters (plain `List`, mutable classes); lambdas capturing changing values; give lazy-list items stable keys |
| UI clipped under bars after targetSdk bump | Edge-to-edge is enforced for newer target SDKs; call `enableEdgeToEdge()` and apply `WindowInsets` padding |
| Background task never runs or is killed | Check WorkManager constraints, battery optimization, foreground-service type in the manifest, exact-alarm permission |
| Build fails after Kotlin/AGP bump | Read the AGP compatibility table (Gradle, JDK, Kotlin); migrate kapt processors to KSP where available; clear configuration cache once |
| ANR | Main-thread disk or network work; enable StrictMode in debug; inspect the ANR trace in logcat or Play vitals |
| Permission flow broken | Runtime permission request plus rationale plus permanent-denial path; prefer the photo picker over broad media permissions |

## Patterns and pitfalls

- **Strong skipping** — current Compose compilers skip recomposition for unstable parameters by instance equality; mutating a list in place still breaks updates. Prefer immutable collections.
- **`derivedStateOf`** — for values that change less often than their inputs (a "scrolled past" flag from scroll offset); not for plain mapping.
- **`rememberUpdatedState`** — when a long-lived effect must call the latest lambda without restarting.
- **Lazy lists** — `items(list, key = { it.id }, contentType = { it.type })` preserves state and recycles efficiently.
- **Dispatchers** — inject dispatchers; tests call runTest with a test dispatcher and `Dispatchers.setMain`. Hard-coded `Dispatchers.IO` makes tests flaky.
- **Room** — `exportSchema = true`, a written migration for every schema change, and `MigrationTestHelper` tests; destructive fallback in production deletes user data.
- **KSP over kapt** — Room, Hilt and Moshi support KSP; kapt is slower and in maintenance.
- **Predictive back** — enable it in the manifest and rely on BackHandler or Navigation Compose rather than intercepting key events; check the target SDK's default behavior.
- **Notifications** — `POST_NOTIFICATIONS` is a runtime permission on newer Android versions; channels must exist before posting.
- **Startup** — Baseline Profiles and Macrobenchmark measure and improve cold start; avoid heavy work in `Application.onCreate` and content providers.
- **Configuration cache** — keep build logic configuration-cache compatible; tasks reading environment at configuration time break caching.
- **Play target API** — Google Play requires a recent `targetSdk` for updates; check the current requirement before release planning.

## Workflow

1. Trace screen → ViewModel → repository → data source and the existing conventions (DI, navigation, state shape).
2. Confirm a supported build matrix before touching versions; read behavior changes for any `targetSdk` change.
3. Implement with lifecycle-owned work, immutable state, explicit loading/error/empty states and TalkBack semantics.
4. Test ViewModel logic with coroutine test utilities; test UI with Compose testing APIs.
5. Exercise rotation, process death, permission denial, offline and window-size changes on an emulator or device.
6. Build the release variant to catch R8 and resource issues.

## Proof

- Unit tests: `./gradlew testDebugUnitTest`
- Instrumented tests on an emulator or device: `./gradlew connectedDebugAndroidTest`
- Lint: `./gradlew lintDebug` (read new warnings, do not baseline them away)
- Release build with R8: `./gradlew assembleRelease` or `./gradlew bundleRelease`
- Dependency conflicts: `./gradlew :app:dependencies --configuration releaseRuntimeClasspath`
- Runtime evidence: `adb logcat -v time` filtered to the app during the journey

## Stop and ask

- The change raises `minSdk`, `targetSdk` or switches UI toolkit (Views to Compose) without being asked.
- Release signing keys, Play Console access or production endpoints are needed.
- A data migration could destroy user data on upgrade.

## Before returning

- [ ] Kotlin, AGP, Gradle, JDK and SDK levels form a verified supported matrix
- [ ] Coroutines lifecycle-scoped; `CancellationException` propagates
- [ ] Compose collects with lifecycle awareness; effects keyed and isolated
- [ ] Rotation and process death keep user input and navigation
- [ ] Permissions, insets and background-work restrictions handled for the target SDK
- [ ] Unit tests, lint and release build pass; emulator versus device evidence stated

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Kotlin releases](https://github.com/JetBrains/kotlin/releases), [Android architecture](https://developer.android.com/topic/architecture), [Android build](https://developer.android.com/build), [AGP compatibility](https://developer.android.com/build/releases/gradle-plugin), [Compose performance](https://developer.android.com/develop/ui/compose/performance).

## Skills in scope

- mobile-design — design and implement mobile interfaces for touch, keyboards, safe areas and native navigation.
- mobile-performance — measure and improve mobile startup, scrolling, animation and resource usage on representative devices.
- mobile-release — prepare and verify signed mobile releases, test-channel distribution and store submission artifacts.
- offline-sync — implement offline-capable applications with local persistence, queued changes and explicit synchronization conflicts.
- testing — coroutine and Compose test harnesses.
