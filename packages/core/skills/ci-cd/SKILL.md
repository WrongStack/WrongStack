---
name: ci-cd
version: 1.0.1
description: "Build and repair reproducible CI and deployment workflows with explicit artifacts, permissions and release gates. Use when working on GitHub Actions or other pipelines, caches, matrices, packaging or deployment evidence; preserve the authoritative checks and never hide failures."
trigger: "working on GitHub Actions or other pipelines, caches, matrices, packaging or deployment evidence; preserve the authoritative checks and never hide failures."
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
metadata:
  routing-group: operations
---

# CI/CD

## Selection card
- Task: Build automated CI checks and delivery pipelines.
- Start: Identify the authorized target, current health and rollback boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Make the pipeline validate the exact source and artifact being shipped.
Distinguish a local check, hosted CI result, published artifact and deployed
service. They are separate evidence boundaries.

## Rules

1. Reproduce the failing authoritative command before editing a pipeline.
   Inspect trigger, job dependencies, working directory, runtime and lockfile.
2. Use the latest stable toolchain target when updating it; verify runner image,
   action version, engine/peer constraints and official migration notes.
3. Give jobs minimal permissions. Pin third-party actions to reviewed commit SHAs
   with identifiable release comments where repository policy calls for it.
4. Keep untrusted PR data out of shell code. Pass it as data through environment
   variables or structured arguments; never run untrusted code with release secrets.
5. Cache dependencies/build inputs with keys that cover the lockfile, runtime
   and platform. A cache hit is not evidence that today's tests ran.
6. Serialize release/shared artifact writers. Failures and skipped jobs remain
   visible; do not add continue-on-error to make a required gate appear green.

## Workflow

1. Map trigger → checks → build → artifact → deployment and who may run each.
2. Fix the narrow source/config cause. Preserve unrelated baselines and required
   branch rules.
3. Run focused local checks and workflow validation available in the repo.
4. If remote execution is authorized, inspect jobs for the exact commit, read
   failed logs and verify required checks rather than an old successful run.
5. Before release, inspect artifact contents, version identity and install/startup.
6. Report commands, hosted run/commit when applicable, artifact/deployment status
   and remaining environment-specific gaps.

## Sources

[GitHub secure workflow use](https://docs.github.com/en/actions/reference/security/secure-use),
reviewed 2026-10-09. Follow the selected CI platform's own current contracts.

## Acceptance checks

- Validate the workflow syntax, least-privilege credentials, matrix conditions and the actual job results.

## Skills in scope

- tech-stack — current compatible runtimes/dependencies.
- docker-deploy — image build/startup.
- verify-before-done — completion evidence.
- git-flow — exact reviewed changes and publication authorization.
