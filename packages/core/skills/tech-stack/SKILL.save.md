# Tech Stack Validator (Compact)

<!-- source-version: 1.5.5 -->

## Selection card
- Task: Verify latest stable versions and migration constraints. / TR: Son kararlı sürüm ve geçiş kısıtını doğrula.
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

## Detailed workflow

Load the full tech-stack skill for live inspection helpers, source adapters and reporting.

## Acceptance checks

- [ ] Installed/resolved and live stable targets recorded with dated registry sources
- [ ] Prerelease tags and deprecated/yanked releases filtered out
- [ ] Engine and peer-dependency blockers stated before recommending or applying upgrades
- [ ] Package manager and lockfile integrity preserved; executed checks reported
