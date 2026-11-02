---
name: tech-stack
description: "Dependency versions and upgrades: latest stable from live registries, peer and engine ranges, outdated packages, migration guides. Use when choosing packages, requesting latest versions, investigating deprecations, or planning a dependency upgrade; preserve the project package manager and distinguish recommendations from installs."
version: 1.5.5
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [verification.run, web.research, filesystem.write]
trigger: "choosing packages, requesting latest versions, investigating deprecations, or planning a dependency upgrade; preserve the project package manager and distinguish recommendations from installs."
metadata:
  routing-group: workflow
---

# Tech Stack Validator

## Selection card
- Task: Verify latest stable versions and migration constraints.
- Start: Read manifests and lockfiles for installed versions, then query the live registry for the current stable release.
- Finish: Installed, latest stable and compatible versions are reported per package with peer or engine blockers and migration notes.

## Overview

Use the latest stable release for new recommendations and requested upgrades.
Verify it live; neither an old repository pin nor a remembered version defines
the target. The [version snapshot](references/current-versions.md) records what
was checked on 2026-10-23, not a permanent claim of latest.

## Rules

1. Identify the relevant workspace manifest, lockfile, runtime and package
   manager. A multi-language repo does not require a question when scope identifies
   the package. Distinguish declared range, resolved version and proposed target.
2. Query the authoritative registry. Read the latest stable tag, release date,
   engine constraints, peer ranges, deprecation/yank status and upstream notices.
   A latest tag can point to a prerelease: inspect semver and resolve a published
   non-deprecated stable release separately. Maven latest/release fields can also
   point at milestones; never label them stable without checking the qualifier.
   A timeout, 403 or registry outage is unknown status, not proof of nonexistence.
3. Recommend the latest stable release. If compatibility blocks it, state the
   blocker and required migration; do not quietly substitute an older release.
   Prereleases require a deliberate user choice.
4. Compare capabilities before replacing a dependency with a built-in. Native
   fetch, UUIDs and filesystem APIs often suffice; interception, server WebSockets,
   database semantics or specialized formatting may justify maintained packages.
5. Age is not a deprecation signal. Do not reject Axios, Jest, Rollup, ESLint,
   pip or any other maintained tool because an alternative exists. Cite an actual
   upstream notice or demonstrated incompatibility.
6. Validation is read-only unless adding/upgrading is authorized. A proposed
   install command and an auto next-step marker do not grant permission.

## Workflow

1. Gather current and target versions. Choose the smallest coherent upgrade
   group: React/react-dom, runner/coverage plugins, related SDK packages.
2. Read official migration notes for each crossed major; list changed APIs,
   runtimes, module formats, config and adapter requirements.
3. Evaluate package necessity, maintenance, licensing and install scripts as
   relevant. Known-advisory hits require affected-range and reachability review.
4. When implementation is requested, use the existing manager to change
   manifests and regenerate lockfiles. Do not hand-edit resolved dependencies.
5. Run the repository's install/build/type/test checks for the affected surface.
   Capture the actual resolved target. Keep unrelated baseline changes separate.
6. Report APPROVED, REJECTED or NEEDS_INVESTIGATION, with evidence and a
   concrete next action. Approval describes the assessment, not installation.

## Registry adapters

| Ecosystem | Authoritative lookup | Selection detail |
|---|---|---|
| npm | registry.npmjs.org/<package> | latest tag plus stable semver validation; inspect engines/peers |
| Python | pypi.org/pypi/<package>/json | requires-python, yanked files and prereleases |
| Rust | crates.io/api/v1/crates/<package> | stable, non-yanked; verify rust-version |
| Go | proxy.golang.org/<escaped-module>/@latest | JSON Version; respect module major paths |
| Ruby | rubygems.org/api/v1/gems/<package>.json | runtime and platform constraints |
| .NET | NuGet v3 service index and registration | listed stable releases; inspect frameworks |
| PHP | repo.packagist.org/p2/<vendor>/<package>.json | stable normalization and PHP constraints |
| Elixir | hex.pm/api/packages/<package> | stable release and Elixir/OTP requirements |
| JVM | Maven Central metadata for group/artifact | stable version and JDK requirements |

Scoped npm names and case-sensitive Go modules need registry-specific encoding;
do not infer latest from the first array item or highest lexicographic string.

## Live npm inspection

For current npm targets and preview-tag detection, run the read-only helper:

~~~powershell
bun run packages/core/skills/tech-stack/scripts/check-versions.mjs expo react-native prisma @prisma/client
bun run skill:check-versions
bun run skill:sync-versions
~~~

`check-versions.mjs` reports selected stable version, latest tag, engines, peers, source and checked
UTC time. `sync-versions.mjs` (`skill:check-versions` / `skill:sync-versions`) audits or updates
`references/stable-registry-check.json`, `references/current-versions.md`, and bundled skill snapshots.

## Report

| Package | Installed | Latest stable | Decision | Source / checked date |
|---|---|---|---|---|
| <name> | <resolved> | <live result> | <compatible / migration needed> | <registry URL> |

Include upgrade deltas, resolved engine/peer constraints, validation commands
and any access failures. State when a source could not be verified.

## Acceptance checks

- [ ] Installed/resolved package versions, live-queried stable targets, and checked dates/URLs are recorded in the report table.
- [ ] Prerelease tags (`next`, `canary`, `rc`, `alpha`, `beta`) and deprecated/yanked releases were filtered out when selecting stable targets.
- [ ] Engine, runtime, and peer-dependency constraints were cross-checked across coherent upgrade groups before recommending or applying changes.
- [ ] Repository package manager and lockfile integrity were preserved, and executed verification commands (or network blockers) are explicitly reported.

## Skills in scope

- `node-modern` — Node.js/Bun runtime engines and standard-library replacement assessment
- `react-modern` — coordinated React, React DOM, and framework peer upgrades
- `typescript-strict` — compiler target, module resolution, and type-definition compatibility
- `security-scanner` — CVE advisory reachability and remediation version selection
- `ci-cd` — frozen-lockfile reproducibility and pipeline image/runtime alignment
