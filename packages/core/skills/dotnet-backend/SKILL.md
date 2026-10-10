---
name: dotnet-backend
description: "Build and upgrade ASP.NET Core services with typed contracts, dependency lifetimes and verified persistence. Use when implementing .NET APIs, background services or runtime migrations; coordinate SDK, target framework and package support."
trigger: "Build and upgrade ASP.NET Core services with typed contracts, dependency lifetimes and verified persistence. Use when implementing .NET APIs, background services or runtime migrations; coordinate SDK, target framework and package support."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "backend"
---

# Dotnet Backend

## Selection card
- Task: Build ASP.NET services and dependency injection.
- Start: Locate the endpoint, schema, authentication boundary and caller.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Build and upgrade ASP.NET Core services with typed contracts, dependency lifetimes and verified persistence.

Checked 2026-10-09: .NET stable SDK 10.0.401 and runtime 10.0.12. .NET 11 RC is a preview, not the stable target. Verify framework/package compatibility before upgrade.

## Rules

1. Inspect global.json, target frameworks, project references and package lock/central management.
2. Preserve dependency lifetimes; singleton services must not capture request-scoped dependencies.
3. Validate/authorize minimal API/controller operations at the server boundary and serialize intended DTOs.
4. Propagate CancellationToken to owned I/O and hosted-service shutdown; avoid sync-over-async on hot paths.
5. Keep DbContext and transactions scoped to units of work; review tracking/concurrency semantics.
6. Separate configuration/secrets from application artifacts and public errors.

## Workflow

1. Trace endpoint/background work and current DI/persistence patterns.
2. Resolve the stable SDK/runtime target and official migration requirements.
3. Implement the narrow feature with existing contracts and cancellation.
4. Test authorization, validation, database failure/concurrency and service stop.
5. Run configured restore/build/tests and publish/start the actual runtime artifact.

## Before returning

SDK/runtime/TFM and package matrix clear; DI/cancellation/persistence ownership verified; publish/startup evidence recorded.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/), [.NET releases](https://dotnet.microsoft.com/en-us/download/dotnet).

## Skills in scope

- api-design — api design contracts and verification.
- database-development — implement database access, models and queries with explicit consistency, transactions and bounded results.
- authentication-sessions — implement application sign-in, sessions and identity integration with explicit account/tenant authorization.
- testing — testing contracts and verification.
