---
name: java-spring
description: "Build and upgrade Java/Spring services with explicit transaction, concurrency and deployment contracts. Use when implementing Spring Boot APIs, data access or jobs; verify JDK/framework/build-tool compatibility and preserve the application architecture."
trigger: "Build and upgrade Java/Spring services with explicit transaction, concurrency and deployment contracts. Use when implementing Spring Boot APIs, data access or jobs; verify JDK/framework/build-tool compatibility and preserve the application architecture."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "backend"
---

# Java Spring

## Selection card
- Task: Implement Spring Boot validation and transactions.
- Start: Locate the endpoint, schema, authentication boundary and caller.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Build and upgrade Java/Spring services with explicit transaction, concurrency and deployment contracts.

Checked 2026-10-09: JDK 27 GA and Spring Boot 4.1.1 stable. Spring Boot 4.2.0-M2 and JDK 28 are previews/early access. Gradle current release is 9.8.1; verify its JDK/plugin matrix.

## Rules

1. Inspect JDK release target, Maven/Gradle wrapper, framework BOM and dependency constraints.
2. Define bean/request/thread ownership; singleton services must not hold mutable per-user state.
3. Validate/authorize endpoints and separate persistence entities from public contracts.
4. Verify transaction/proxy boundaries and rollback behavior; annotations do not apply identically to every call shape.
5. Bound external I/O and executors and handle shutdown/cancellation deliberately.
6. Check migration effects on serialization, reflection/native-image behavior and deployment runtime.

## Workflow

1. Trace controller → service → transaction/data boundary and existing conventions.
2. Establish the latest stable supported toolchain/framework combination.
3. Implement the narrow feature and coherent package/BOM changes if requested.
4. Test validation/auth, transaction failure, concurrency and application lifecycle.
5. Run project tests/build and the packaged service startup/user path.

## Before returning

GA/stable versus preview explicit; transaction/call boundaries tested; dependency/JDK compatibility and packaged runtime behavior recorded.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[JDK releases](https://jdk.java.net/), [Spring requirements](https://docs.spring.io/spring-boot/system-requirements.html).

## Skills in scope

- api-design — api design contracts and verification.
- database-development — implement database access, models and queries with explicit consistency, transactions and bounded results.
- queues-jobs — implement reliable asynchronous jobs and message consumers with explicit delivery, retry and shutdown semantics.
- testing — testing contracts and verification.
