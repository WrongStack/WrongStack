---
name: tech-stack
description: |
  Use this skill when validating package versions, checking for outdated dependencies,
  or evaluating third-party libraries in WrongStack. Triggers: user says "dependency",
  "package version", "outdated", "npm audit", "deprecated package", "tech stack".
version: 1.2.0
---

# Tech Stack Validator — WrongStack (Language-Agnostic)

## Overview

Intervening validation layer that fires before a package, library, or framework
choice is committed — for **any language**. Uses an ecosystem adapter pattern:
core validation logic is universal; the registry endpoint, package manager
command, prehistoric reject list, and built-in preference map vary per
ecosystem. Runs as a single-shot delegate — fast, read-only, fire-and-forget.

## Rules

1. **Detect the ecosystem first.** Before anything else, determine which
   language/ecosystem the package belongs to. Two strategies, tried in order:
   - **Explicit**: The user names the language ("add `requests` to our Python project")
   - **Implied**: Scan project files for ecosystem markers:
     - `package.json` (js), `tsconfig.json` (ts) → **JavaScript/TypeScript**
     - `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt` → **Python**
     - `Cargo.toml` → **Rust**
     - `go.mod` → **Go**
     - `Gemfile` → **Ruby**
     - `*.csproj`, `*.fsproj`, `packages.config` → **.NET**
     - `composer.json` → **PHP**
     - `mix.exs` → **Elixir**
     - `pom.xml`, `build.gradle` → **Java/JVM**
   - If multiple markers exist, ask the user which ecosystem.
   - If NO markers exist and the user hasn't specified, default to **JavaScript**
     when `package.json` is present, otherwise ask.

2. **Verify existence.** Consult the registry for the detected ecosystem
   (see Ecosystem Registry Map below). Fetch the package endpoint. A package
   that returns 404 or doesn't exist in the registry is a hallucination.

3. **Check latest version.** Always fetch the actual latest stable version from
   the ecosystem's registry. The LLM's training data is stale — never trust a
   version number from the model without checking.

4. **Reject dead packages.** If a package has had no release in >2 years AND
   has unresolved critical issues, flag it as dead. Suggest a maintained
   replacement. Registry-specific dead signals:
   - npm: `"deprecated"` field, archived GitHub repo
   - PyPI: yanked releases, `Development Status :: 7 - Inactive` classifier
   - Crates.io: yanked versions, archived repo
   - Rubygems: `"version": null` for yanked, archived repo
   - NuGet: deprecated flag, `listed: false`

5. **Reject prehistoric technology.** Any package/library/pattern that was
   superseded ≥5 years ago is automatically rejected. Use the per-ecosystem built-in
   preference map below before greenlighting any third-party dependency.

6. **Prefer built-in over third-party.** Every modern language runtime ships
   standard library that obsoletes packages. Check the per-ecosystem built-in
   map below before greenlighting any third-party dependency.

7. **Single-shot budget.** This agent is not for deep analysis — it should
   complete in 1–2 iterations. Detect → search registry → verify → report.
   Do not recursively analyze transitive dependencies.

## Ecosystem Registry Map

The central dispatch table. When verifying a package, use the adapter for the
detected ecosystem:

| ID | Language | Registry Host | Path Template | Version Field | Package Manager | Install Command |
|----|----------|--------------|---------------|---------------|-----------------|-----------------|
| `js` | JavaScript/TS | `registry.npmjs.org` | `/{pkg}/latest` | `version` | npm/pnpm/yarn | `pnpm add {pkg}@{version}` |
| `python` | Python | `pypi.org` | `/pypi/{pkg}/json` | `info.version` | pip/poetry/uv | `pip install {pkg}=={version}` |
| `rust` | Rust | `crates.io` | `/api/v1/crates/{pkg}` | `crate.max_stable_version` | cargo | `cargo add {pkg}@{major}` |
| `go` | Go | `proxy.golang.org` | `/{pkg}/@latest` | *(plain text)* | go | `go get {pkg}@{version}` |
| `ruby` | Ruby | `rubygems.org` | `/api/v1/gems/{pkg}.json` | `version` | bundler | `gem "{pkg}", "~> {major}.{minor}"` |
| `dotnet` | .NET | `api.nuget.org` | `/v3/registration5-gz-semver2/{pkg_lower}/index.json` | `items[0].upper` | dotnet | `dotnet add package {pkg} --version {version}` |
| `php` | PHP | `repo.packagist.org` | `/p2/{vendor}/{pkg}.json` | `packages[..].0.version` | composer | `composer require {vendor}/{pkg}:^{major}.{minor}` |
| `elixir` | Elixir | `hex.pm` | `/api/packages/{pkg}` | `releases[0].version` | mix | `{:pkg, "~> {major}.{minor}"}` (add to mix.exs) |
| `jvm` | Java/JVM | `search.maven.org` | `/solrsearch/select?q=g:{group}+AND+a:{artifact}&rows=1&wt=json` | `response.docs[0].latestVersion` | maven/gradle | `implementation '{group}:{artifact}:{version}'` |

## Output format

```
### Tech Stack Validation — <package>

**Ecosystem**: <detected ecosystem>
**Status**: APPROVED | REJECTED | NEEDS_INVESTIGATION

**Package**: <name>@<version>
**Registry**: <host + URL fetched>
**Age**: <first release year> — <last release date>
**Verdict**: 1–2 sentence explanation.

When REJECTED:
**"This isn't code, this is X-year-old technology."**
**Replaced by**: <modern alternative>
**Migration**: <one concrete step>

When APPROVED:
**Install**: `<ecosystem install command>`
**Note**: <any caveats about the version, semver range, or compatibility>

<nextsteps>
1. Add <package>@<version> to the project auto="true"
</nextsteps>
```

## Skills in scope

- `node-modern` — for Node.js built-in vs. third-party decisions
- `react-modern` — for React version checks
- `typescript-strict` — for TypeScript version alignment
- `security-scanner` — for packages with known CVEs
- `docker-deploy` — for base image version pinning
- `output-standards` — for standardized `<nextsteps>` formatting
