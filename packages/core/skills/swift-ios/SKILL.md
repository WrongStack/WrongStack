---
name: swift-ios
description: "Build and upgrade native iOS applications with Swift, SwiftUI/UIKit and correct lifecycle/concurrency ownership. Use when implementing native screens, platform integrations or Swift migrations; verify toolchain, deployment target and device behavior separately."
trigger: "Build and upgrade native iOS applications with Swift, SwiftUI/UIKit and correct lifecycle/concurrency ownership. Use when implementing native screens, platform integrations or Swift migrations; verify toolchain, deployment target and device behavior separately."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: mobile
  domain: "mobile"
---

# Swift Ios

## Selection card
- Task: Build SwiftUI and Apple platform features.
- Start: Identify the platform, screen, device and native integration boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Build and upgrade native iOS applications with Swift, SwiftUI/UIKit and correct lifecycle/concurrency ownership.

Checked stable Swift target: 6.4.0 on 2026-10-09. Xcode/SDK, Swift language mode and minimum deployment OS are separate constraints; verify current supported combinations before migration.

## Rules

1. Inspect project/schemes, deployment targets, entitlements and package/toolchain pins.
2. Keep UI state ownership explicit and isolate UI mutations to the appropriate actor.
3. Scope Tasks, observers and delegates to lifecycle; cancellation and late completion must respect owner replacement.
4. Use secure platform storage/permissions with denied/revoked states and server-side authorization.
5. Match native navigation, dynamic type, safe areas and accessibility rather than copying desktop geometry.
6. Do not label a simulator build as signed-device or App Store release proof.

## Workflow

1. Trace screen/model/service ownership and current SwiftUI/UIKit conventions.
2. Verify stable toolchain and migration effects on concurrency and packages.
3. Implement the feature with intentional actor/lifecycle boundaries.
4. Test background/resume, cancellation, permissions, large text and navigation.
5. Build/test the selected scheme and verify representative device behavior.

## Before returning

Toolchain/language/deployment targets explicit; actor/lifecycle state safe; simulator/device/signing evidence distinguished.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Swift releases](https://www.swift.org/install/), [Apple development](https://developer.apple.com/documentation/).

## Skills in scope

- mobile-design — design and implement mobile interfaces for touch, keyboards, safe areas and native navigation.
- mobile-performance — measure and improve mobile startup, scrolling, animation and resource usage on representative devices.
- mobile-release — prepare and verify signed mobile releases, test-channel distribution and store submission artifacts.
- authentication-sessions — implement application sign-in, sessions and identity integration with explicit account/tenant authorization.
