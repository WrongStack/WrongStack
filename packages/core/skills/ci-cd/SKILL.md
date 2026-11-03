---
name: ci-cd
version: 1.1.2
description: "CI/CD pipelines in GitHub Actions, GitLab CI, Jenkins and CircleCI: workflow YAML, caches, matrices, secrets, OIDC, deploy gates. Use when a pipeline fails, hangs or flakes, needs hardening (permissions, pinned actions, pull_request_target), or must build, sign and promote an artifact. Not for image internals (use docker-deploy) or branch and tag policy (use git-flow)."
trigger: "Use when editing .github/workflows, .gitlab-ci.yml or a Jenkinsfile, or when a CI run fails, leaks secrets or deploys the wrong artifact."
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
metadata:
  routing-group: operations
paths: [".github/workflows/*.{yml,yaml}", ".gitlab-ci.yml", "Jenkinsfile", ".circleci/config.yml", "azure-pipelines.yml"]
---

# CI/CD

## Selection card
- Task: Build, repair or harden CI checks and delivery pipelines.
- Start: Read the workflow file, the failing run's log for the exact commit, and the scripts it calls (package.json, Makefile).
- Finish: the authoritative command passes locally, the workflow lints clean, and hosted, artifact and deployed evidence are reported separately.

## Overview

A pipeline is a privileged program running attacker-influenced input: its token, triggers and third-party actions are the attack surface, and a green check proves only the commit it built.
Local check, hosted CI result, published artifact and deployed service are separate evidence boundaries.
Use the latest stable toolchain when updating; verify runner image, action versions and engine constraints from official migration notes.

## Rules

1. Reproduce from the failing run's own log and commit before editing (`gh run view <id> --log-failed`); a local pass or a green rerun of an older SHA is different evidence.
2. Default the token to read: top-level `permissions: contents: read`, elevated per job only (`id-token: write` for OIDC, `packages: write`). Prefer OIDC federation to long-lived cloud keys.
3. Never interpolate `${{ github.event.* }}`, `github.head_ref` or other attacker-controlled context into `run:`; pass it through `env:` and quote it. Never check out or execute PR code in `pull_request_target` or `workflow_run` jobs that hold secrets.
4. Pin third-party actions to a full commit SHA with a version comment and let Dependabot or Renovate bump them; tags are mutable (the 2025 tj-actions/changed-files compromise rewrote tags to dump secrets).
5. Gates fail visibly: no `continue-on-error` or `|| true` on required checks, and no path filter on a required workflow unless a job always reports.
6. Build once and promote the same artifact by digest or checksum; never rebuild production from a tag during release or rollback.
7. Every job sets `timeout-minutes` (default is 360); deploy jobs share a `concurrency` group without cancel-in-progress, PR workflows cancel superseded runs.
8. Cache keys include OS, runtime version and lockfile hash; cache dependencies, not the outputs tests must prove.

## First moves by situation

| Situation | First moves |
|---|---|
| Red in CI, green locally | `gh run view <id> --log-failed`; compare runner image, runtime version, frozen-lockfile install, env vars, TZ/locale, case-sensitive paths, secrets missing on fork PRs |
| Flaky job | `gh run list --workflow ci.yml --limit 20`; `gh run rerun <id> --failed`; same test each time? look for ports, time, ordering, shared state |
| Slow pipeline | Per-job timings, cache hit/miss lines, `needs:` critical path, toolchain reinstalls per job, matrix width |
| Security review | `zizmor .github/workflows/` and `actionlint`; grep `pull_request_target`, `workflow_run`, `${{ github.event`, `secrets: inherit`, unpinned `uses:` |
| Required check stuck "Expected" | Workflow skipped by a `paths:`/`branches:` filter or a renamed job; make the required job always run and report status |
| Workflow did not trigger | Pushes and tags made with `GITHUB_TOKEN` start no new runs (except dispatch events); check `on:` filters; `schedule` runs only on the default branch |
| Deploy from CI | OIDC trust scoped to repo plus environment or ref; environment protection rules; deploy concurrency group; digest recorded |
| GitLab pipeline | `rules:` evaluation order, `needs:` DAG, protected variables only on protected refs, `CI_JOB_TOKEN` scope; `glab ci lint` |

## Patterns and pitfalls

- **Default shell lacks pipefail** — an unqualified `run:` on Linux uses `bash -e {0}`; `shell: bash` gives `bash --noprofile --norc -eo pipefail {0}`, so `cmd | tee log` failures surface only with the explicit shell. Windows runners default to pwsh.
- **Checkout persists the token** — `actions/checkout` stores credentials in `.git/config` unless `persist-credentials: false`; later steps or uploaded workspaces can leak it.
- **Cache poisoning** — runs restore caches from their own ref and the base/default branch. A `pull_request_target` job runs in base context, so caches it saves are shared; never save caches there.
- **OIDC subject too broad** — a trust policy matching `repo:org/app:*` lets any branch or PR workflow assume the role. Match `repo:org/app:environment:production` or a specific ref.
- **Boolean inputs** — `inputs.flag` from `workflow_dispatch` is a boolean, but `github.event.inputs.flag` is the string `"false"`, which is truthy in `if:`.
- **Status functions** — `if: always()` runs even after cancellation; prefer `if: ${{ !cancelled() }}` for report uploads. `fail-fast` defaults to true and cancels sibling matrix legs.
- **Artifacts v4+** — `actions/upload-artifact` names are immutable within a run; matrix legs need unique names and `merge-multiple: true` on download.
- **Masking gaps** — masking misses transformed secrets (base64, JSON-escaped, split); register derived values with `::add-mask::` and never echo env dumps.
- **Reusable workflows** — `secrets: inherit` forwards every secret; pass the named ones a callee needs.
- **Self-hosted runners** — never attach them to public repositories that accept fork PRs; prefer ephemeral runners.
- **Action runtime deprecations** — JavaScript actions pin a Node runtime that GitHub retires on a schedule; deprecation annotations mean the action needs a bump (check the GitHub changelog for current dates).

## Workflow

1. Map trigger → jobs → build → artifact → deploy, and who or what may start each (events, forks, environments).
2. Read the failing log for the exact commit; reproduce the authoritative command locally with the same runtime and frozen lockfile.
3. Fix the narrow cause in source or workflow; keep unrelated baselines and required checks intact.
4. Lint the workflow and review permissions, pinning and untrusted inputs touched by the change.
5. If hosted execution is authorized, push or dispatch once, watch the exact run, and read logs rather than the badge.
6. Before release, inspect artifact contents, version identity and checksum; record the deployed version and how to roll back.

## Proof

Prefer the repository's own scripts and workflow commands. Common defaults:
- Static: `actionlint` (includes shellcheck on `run:` blocks when installed), `zizmor .github/workflows/`, `glab ci lint` for GitLab
- Local reproduction: the project script the job calls (`bun run test`, `npm test`, `make check`); `act -j <job>` only as an approximation
- Hosted: `gh run watch <id> --exit-status`, `gh run view <id> --log-failed`, `gh run list --branch <branch> --limit 5`
- Artifact: `gh run download <id> -n <name>`, `sha256sum`, `docker buildx imagetools inspect <ref>`, `gh attestation verify <file> --repo <owner>/<repo>`
- Deployed: the service's version or health endpoint reports the expected SHA or digest

## Stop and ask

- Changing branch protection, required checks, environment protection rules, secrets or OIDC trust policies.
- Running release or deploy workflows, publishing packages or pushing tags.
- Adding `pull_request_target`, self-hosted runners, or write permissions to PR-triggered workflows.
- The only route to green is weakening or skipping a gate.
- Repeated hosted reruns or dispatches would burn quota when a local reproduction is possible.

## Before returning

- [ ] Failure reproduced from the exact run log and commit; fix addresses that cause
- [ ] Top-level read-only `permissions`, per-job elevation, `timeout-minutes` and `concurrency` set
- [ ] Untrusted context passed via `env:`; no PR code executed with secrets; actions pinned to SHAs
- [ ] Cache keys include OS, runtime and lockfile hash; no `continue-on-error` or `|| true` on gates
- [ ] Workflow linted (`actionlint` or platform linter) with the output reported
- [ ] Local, hosted, artifact and deployed evidence reported separately with run IDs or digests

## Sources

[GitHub secure workflow use](https://docs.github.com/en/actions/reference/security/secure-use),
reviewed 2026-11-02. Follow the selected CI platform's own current contracts.

## Skills in scope

- tech-stack — runtime, package manager, and toolchain version alignment across local and CI runners.
- docker-deploy — multi-stage container builds, layer cache exports, and digest pinning in CI.
- verify-before-done — running the authoritative repo verification suite before declaring pipeline fixes complete.
- git-flow — branch protection rules, commit hygiene, and release tag workflows.
- release-rollback — promoting the built artifact and keeping a tested rollback path.
- security-scanner — supply-chain and secret findings in workflows and dependencies.
