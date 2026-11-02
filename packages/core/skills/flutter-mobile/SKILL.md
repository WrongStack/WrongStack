---
name: flutter-mobile
description: "Flutter and Dart apps: widgets, state (Riverpod, Bloc, Provider), go_router, platform channels/Pigeon, pubspec.yaml and builds. Use when building or fixing Flutter screens, state, navigation, plugins, Android/iOS build failures or a Flutter SDK upgrade; distinguish stable SDK releases from future branch schedules. Not for React Native (use react-native-expo) or store submission (use mobile-release)."
trigger: "Use when the change touches *.dart files, pubspec.yaml, Flutter platform folders or a Flutter build."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: mobile
  domain: "mobile"
paths: ["pubspec.yaml", "*.dart"]
---

# Flutter Mobile

## Selection card
- Task: Build or repair Flutter widgets, state, navigation and platform integration.
- Start: Read pubspec.yaml and pubspec.lock, analysis_options.yaml, the SDK pin and the screen's widget, state and route definitions.
- Finish: `flutter analyze` and tests pass, the platform build succeeds, and the journey was exercised on a simulator or device (stated which).

## Overview

Flutter rebuilds widgets constantly, so correctness depends on `build()` being pure, state living in owned objects that are disposed, and no `BuildContext` used after an `await` without a `mounted` check.
Checked 2026-11-02: Flutter 3.47.9 stable with bundled Dart SDK 3.13.7 (verified via official releases_linux.json). Use its bundled Dart SDK, not an independently guessed Dart upgrade. Refresh the official stable archive before installation; future Flutter 3.50 scheduling is not a released stable target.

## Rules

1. `build()` creates no controllers, futures or streams and starts no work. Create them in `initState` (or the state library's provider) and dispose them in `dispose`.
2. After every `await` in a widget, check `if (!context.mounted) return;` (or `mounted` in a State) before using context, navigation or `setState`.
3. Follow the project's state-management library and its idioms; do not introduce a second one for one screen.
4. Match plugin versions and native toolchains (Gradle, AGP, Kotlin, Xcode, CocoaPods or SwiftPM) to the pinned Flutter stable release; upgrade them together.
5. Layout from constraints (`LayoutBuilder`, `MediaQuery.sizeOf`, `SafeArea`, slivers) and support text scaling; no fixed pixel heights around text.
6. Platform channels are contracts: typed (Pigeon preferred), errors surfaced as `PlatformException` handling, never silent success.
7. Nothing secret in the app: `--dart-define` values and assets ship inside the binary.

## First moves by situation

| Situation | First moves |
|---|---|
| `setState() called after dispose()` or context errors | Find the `await` before it; add `mounted`/`context.mounted` guards; cancel timers and subscriptions in `dispose` |
| Screen rebuilds too much or janks | Profile in `--profile` mode with DevTools; push `const` down; narrow subscriptions (`select`, `ValueListenableBuilder`); replace `MediaQuery.of` with `MediaQuery.sizeOf` |
| Long list stutters | `ListView.builder`/`SliverList.builder`, `itemExtent` or `prototypeItem`, cached image sizes |
| Android build fails after upgrade | Check AGP/Gradle/Kotlin versions against Flutter's requirements; migrate to the declarative Flutter Gradle plugin; read the full Gradle error, not the summary |
| iOS build fails | `pod repo update`, deployment target in Podfile and Xcode project, signing team; check whether the project uses SwiftPM or CocoaPods |
| Deprecation warnings flood after SDK bump | `dart fix --dry-run`, then `dart fix --apply`; review each change |
| Back button or gesture misbehaves | Replace `WillPopScope` with `PopScope` (`canPop`, `onPopInvokedWithResult`) for predictive back |
| Plugin call hangs or crashes | Check the native side runs on the platform main thread; background isolates need `BackgroundIsolateBinaryMessenger` |

## Patterns and pitfalls

- **`FutureBuilder(future: load())` in build** — restarts the request on every rebuild; store the future in state or a provider.
- **Riverpod** — `ref.watch` in build, `ref.read` in callbacks, `ref.listen` for side effects (snackbars, navigation); `autoDispose` for screen-scoped state.
- **Keys** — `ValueKey(id)` for list items that hold state or reorder; `GlobalKey` is expensive and rarely needed.
- **go_router** — `context.go` replaces the stack, `context.push` adds to it; auth redirects belong in `redirect`, refreshed with `refreshListenable`.
- **Deprecated APIs worth knowing** — `Color.withOpacity` gave way to `withValues(alpha: ...)`, `textScaleFactor` to `TextScaler`, `WillPopScope` to `PopScope`; `dart:html` to `package:web` with `dart:js_interop` for web and Wasm builds.
- **App lifecycle** — `AppLifecycleListener` for resume/pause handling; refresh stale data and tokens on resume.
- **Isolates** — `Isolate.run()` for heavy parsing or image work; isolates cannot touch widgets, and plugins need the background messenger.
- **Impeller** — the default renderer on iOS and modern Android; rendering bugs must be reproduced on device, not only in the simulator, before filing or working around them.
- **Golden tests** — font rendering differs per OS; run goldens on one pinned platform in CI and update deliberately with `--update-goldens`.
- **Images** — `cacheWidth`/`cacheHeight` (or `ResizeImage`) to decode at display size; full-resolution decodes cause memory spikes.
- **Text input** — `TextEditingController` lifecycle, `keyboardType`, `textInputAction`, `autofillHints`; scroll focused fields above the keyboard.
- **Flavors** — separate bundle ids, icons and config per flavor with `--flavor` and `--dart-define-from-file`; never ship debug endpoints in release.

## Workflow

1. Read pubspec, analysis options, SDK pin and native folders; note the state and navigation pattern in neighbouring screens.
2. For upgrades, read the release notes and breaking changes for each crossed version; upgrade Flutter, plugins and native tooling together.
3. Implement with typed models, owned controllers, explicit loading/error/empty states and accessibility semantics.
4. Exercise long content, large text, keyboard, back navigation, permission denial and app resume.
5. Run analysis, tests and platform builds; then the real device or simulator journey.

## Proof

- Analysis and style: `flutter analyze` and `dart format --output=none --set-exit-if-changed .`
- Tests: `flutter test` (widget and unit); integration: `flutter test integration_test` on a device or simulator
- Dependencies: `flutter pub outdated` and `flutter pub get` with a clean lockfile diff
- Builds: `flutter build appbundle --release` and `flutter build ipa` (or `flutter build ios --no-codesign` without signing)
- Performance: `flutter run --profile` with DevTools frame chart; never judge performance in debug mode
- Environment: `flutter doctor -v` output attached when a build fails

## Stop and ask

- The fix requires changing the state-management library, navigation package or minimum OS versions.
- Signing, provisioning or store credentials are needed.
- An SDK upgrade forces a plugin without a compatible release.

## Before returning

- [ ] Flutter stable version, bundled Dart SDK and plugin/native toolchain compatibility verified
- [ ] No work started in `build()`; controllers, focus nodes and subscriptions disposed
- [ ] Context and `setState` guarded after every `await`
- [ ] Layout survives large text, small screens, keyboard and safe areas
- [ ] `flutter analyze`, format check and tests pass on touched code
- [ ] Platform build ran; device versus simulator versus widget-test evidence stated

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Stable SDK archive](https://docs.flutter.dev/install/archive), [Confirmed release tag](https://flutter.googlesource.com/mirrors/flutter/+/refs/tags/3.47.9), [Flutter testing](https://docs.flutter.dev/testing), [Breaking changes](https://docs.flutter.dev/release/breaking-changes), [Performance](https://docs.flutter.dev/perf).

## Skills in scope

- mobile-design — adaptive touch targets, safe areas, keyboard insets, and platform navigation idioms.
- mobile-performance — Impeller frame rasterization, shader/jank profiling, and isolate memory verification.
- mobile-release — iOS/Android signing, build flavors, and store artifact verification.
- offline-sync — local SQLite/Drift persistence, outbox queues, and conflict resolution across connectivity drops.
- accessibility — semantics labels, focus order and screen reader behavior.
