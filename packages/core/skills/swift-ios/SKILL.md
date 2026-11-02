---
name: swift-ios
description: "Native iOS with Swift: SwiftUI, UIKit, Swift 6 concurrency (actors, Sendable, MainActor), @Observable, SwiftData, Xcode and Package.swift. Use when building or fixing iOS screens, navigation, data flow, concurrency errors, platform integrations or Swift/Xcode migrations; verify toolchain, deployment target and device behavior separately. Not for cross-platform apps (use react-native-expo or flutter-mobile) or App Store submission (use mobile-release)."
trigger: "Use when the change touches *.swift files, Package.swift, Info.plist, an Xcode project or Swift concurrency diagnostics."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: mobile
  domain: "mobile"
paths: ["*.swift", "Package.swift", "Info.plist"]
---

# Swift iOS

## Selection card
- Task: Build or repair native iOS features with SwiftUI/UIKit, data flow and Swift concurrency.
- Start: Read the Xcode project or Package.swift settings (Swift language mode, deployment target, default isolation), Info.plist and the affected view and model.
- Finish: the scheme builds and tests on a named simulator (and device when hardware matters) with zero new concurrency diagnostics, and the checks below pass.

## Overview

Swift 6 turns data races into compile errors, so iOS work is mostly about isolation: UI state on the main actor, shared mutable state inside actors, values crossing boundaries `Sendable`, and every task owned by something that cancels it.
Checked stable Swift target: 6.4.2 on 2026-10-23. Xcode/SDK, Swift language mode and minimum deployment OS are separate constraints; verify current supported combinations before migration.
The compiler version, the language mode (5 or 6) and the deployment target are three different settings; read all three before changing code.

## Rules

1. Fix concurrency diagnostics by modeling isolation correctly (`@MainActor`, actors, `Sendable` values), not with `@unchecked Sendable`, `nonisolated(unsafe)` or `@preconcurrency` unless a documented lock or legacy API justifies it.
2. Tie async work to view lifetime with `.task {}` or `.task(id:)`, which cancel automatically; a `Task {}` inside `onAppear` is never cancelled.
3. Inside an actor, re-check state after every `await`: actors are reentrant, and another call may have changed the state during suspension.
4. Use the observation model the project uses: `@Observable` with `@State`/`@Bindable`/`@Environment`, or `ObservableObject` with `@StateObject`/`@ObservedObject` — and never create an owned model in `@ObservedObject`.
5. Keep `body` cheap and side-effect free; it is recomputed often.
6. Tokens and credentials go to the Keychain, never `UserDefaults` or `@AppStorage`.
7. Every protected resource has its Info.plist usage description, and required-reason APIs are declared in `PrivacyInfo.xcprivacy`.

## First moves by situation

| Situation | First moves |
|---|---|
| Swift 6 migration floods errors | Enable complete checking module by module; start with leaf modules; check whether the target uses default main-actor isolation |
| "Sending X risks causing data races" | Make the type `Sendable` (value type, immutable class, or actor), or keep it inside one isolation domain |
| UI updated from background | Mark the model `@MainActor`; hop with `await MainActor.run` only at the boundary |
| View state resets unexpectedly | Identity changed: conditional `if` branches, unstable `ForEach` ids, `.id()` modifier; prefer toggling modifiers |
| Work continues after leaving a screen | Replace `onAppear { Task {...} }` with `.task`; check `Task.isCancelled` or `try Task.checkCancellation()` in loops |
| Crash on camera, photos or location access | Missing `NS...UsageDescription` key in Info.plist |
| Memory grows per navigation | Retain cycles in escaping closures and stored Combine subscriptions; use Instruments Leaks and the memory graph debugger |
| SwiftData migration or threading crash | Versioned schemas with a migration plan; never pass `ModelContext` across actors, use a model actor |

## Patterns and pitfalls

- **Default isolation** — recent toolchains let a module default to `MainActor` isolation and run nonisolated async functions on the caller's actor; read the target's build settings, because the same code means different things in different modules.
- **`Task` versus `Task.detached`** — `Task {}` inherits the current actor and priority; detached tasks inherit nothing and are rarely needed.
- **`@Observable` granularity** — views track only the properties they read; reading a whole model in a parent re-renders more than needed.
- **NavigationStack** — data-driven navigation with `navigationDestination(for:)` and a path enables deep links and state restoration; `NavigationView` is deprecated.
- **Lists** — stable `Identifiable` ids; never `id: \.self` for mutable values.
- **UIKit interop** — `UIViewRepresentable` coordinators own delegates; update the UIKit view in `updateUIView` idempotently.
- **Background tasks** — `BGTaskScheduler` identifiers must be listed in Info.plist; tasks get limited time and must handle expiration.
- **String Catalogs** — `.xcstrings` with pluralization; no concatenated localized fragments.
- **Swift Testing** — `@Test` and `#expect` coexist with XCTest; async tests await real work instead of sleeping.
- **Keychain accessibility** — choose an accessibility class that matches background needs (after first unlock versus when unlocked).
- **Previews** — keep previews compiling with sample data; a broken preview usually signals hidden dependencies in the view.
- **Launch performance** — avoid synchronous work in `App.init` and the first scene; measure with Instruments App Launch.

## Workflow

1. Read build settings: Swift language mode, upcoming features, default isolation, deployment target, signing team.
2. Trace view → model → service; identify which actor owns each piece of state.
3. Implement with explicit isolation, owned tasks, typed errors and visible loading/error/empty states plus VoiceOver labels.
4. Test models with Swift Testing or XCTest; use previews and UI tests for flows.
5. Run on a simulator, and on a device for camera, push, background, performance or hardware features.

## Proof

- Find a simulator: `xcrun simctl list devices available`
- Build and test: `xcodebuild -scheme <App> -destination 'platform=iOS Simulator,name=<device>' build test`
- Packages: `swift build` and `swift test`
- Settings check: `xcodebuild -scheme <App> -showBuildSettings` (read SWIFT_VERSION and IPHONEOS_DEPLOYMENT_TARGET)
- Formatting or lint if configured: `swift format lint --recursive Sources` or the project's SwiftLint step
- Runtime evidence: Instruments (Time Profiler, Leaks, SwiftUI) or Console logs from the run

## Stop and ask

- The change raises the deployment target or switches language mode for the whole app.
- Signing certificates, provisioning profiles or App Store Connect access are required.
- Fixing a diagnostic seems to need `@unchecked Sendable` or `nonisolated(unsafe)` without a lock to justify it.

## Before returning

- [ ] Swift toolchain, language mode, default isolation and deployment target verified
- [ ] No new concurrency diagnostics; unsafe opt-outs justified in comments
- [ ] Async work owned by `.task`/structured tasks and cancellable
- [ ] Observation model consistent; owned models not held by `@ObservedObject`
- [ ] Credentials in Keychain; Info.plist usage strings and privacy manifest complete
- [ ] Build and tests pass on a named simulator; device evidence stated when hardware matters

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Swift releases](https://www.swift.org/install/), [Apple development](https://developer.apple.com/documentation/), [Swift 6 migration](https://www.swift.org/migration/documentation/migrationguide/), [Observation](https://developer.apple.com/documentation/observation).

## Skills in scope

- mobile-design — design and implement mobile interfaces for touch, keyboards, safe areas and native navigation.
- mobile-performance — measure and improve mobile startup, scrolling, animation and resource usage on representative devices.
- mobile-release — prepare and verify signed mobile releases, test-channel distribution and store submission artifacts.
- authentication-sessions — implement application sign-in, sessions and identity integration with explicit account/tenant authorization.
- offline-sync — local persistence and sync conflicts with SwiftData or Core Data.
