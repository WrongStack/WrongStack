---
name: release-rollback
description: "Release promotion and rollback: canary, blue/green, rolling deploys, feature flags, Helm, kubectl, Wrangler and symlink switches. Use when shipping a version to production, defining promotion gates and abort thresholds, rolling back a bad release, or checking that the previous version survives the new one's schema, cache and queue changes. Not for building the artifact (use ci-cd) or running the outage itself (use incident-response)."
trigger: "Use when a request is about promoting, canarying or rolling back a release, or whether a rollback is still safe after schema or data changes."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "deployment"
---

# Release Rollback

## Selection card
- Task: Promote a release safely or return to the previous one.
- Start: Record the running version tuple (git SHA, artifact digest or version ID, config revision, schema revision) and write the exact rollback command before anything moves.
- Finish: live instances report the intended version, gate signals held for the observation window, and the rollback target plus irreversible side effects are documented.

## Overview

A release is safe to promote only when the previous version can still run against everything the new one writes, and rolling back is a pointer switch to a retained artifact rather than a rebuild.
Read [promotion and recovery](references/promotion.md) for a consequential release. Use current platform rollout/version APIs and supported image/runtime targets.
Reverting code never reverts data, sent messages or external side effects.

## Rules

1. Record the vN-1 and vN tuples (SHA, digest or version ID, config revision, schema revision) and the tested rollback command before promotion.
2. Define gates and abort thresholds up front: error rate, p95/p99 latency, saturation, one business signal (checkout or login success), queue failures, and the observation window. Compare canary against the current baseline, not yesterday.
3. Keep both directions compatible: expand-and-contract schema changes, additive and optional payload fields, versioned cache keys. Destructive contract steps wait until the rollback window closes.
4. One deployment writer at a time. Pause auto-deploy or GitOps auto-sync before a manual promotion or rollback, or perform the rollback as a Git revert.
5. Retain the vN-1 artifact, static assets and config so rollback is a switch (digest, version ID, Helm revision, symlink), never a rebuild from source.
6. When a gate trips, roll back first and debug later, unless the change is on the pre-agreed "rollback unsafe" list; then disable the flag or roll forward.
7. Separate deploy from release with feature flags where possible; test the kill switch and keep its default safe.
8. Shift live traffic, promote or roll back only within explicit authorization; local preparation is a separate step.

## First moves by situation

| Situation | First moves |
|---|---|
| Plan a production release | Fill the tuple; run the compatibility matrix in the reference; choose rolling, canary or blue/green; write thresholds and the rollback command |
| Kubernetes Deployment | `kubectl rollout history deploy/<name> -n <ns>`; `kubectl rollout undo deploy/<name> -n <ns> --to-revision=<n>`; ConfigMaps and Secrets are not reverted; under GitOps revert the commit |
| Helm release | `helm history <release> -n <ns>`; `helm rollback <release> <revision> -n <ns> --wait`; CRDs in `crds/` are not upgraded or rolled back by Helm |
| Progressive delivery controller | Abort or promote through it (Argo Rollouts, Flagger) so the controller and traffic router stay consistent |
| Cloudflare Worker | `wrangler deployments list`; `wrangler versions deploy` for gradual percentages; `wrangler rollback <version-id>`; storage data is not reverted |
| VPS release directories | `readlink -f /srv/app/current`; switch atomically to the previous directory; restart or reload the unit; check the version endpoint |
| Compose host | Restore the previous image digest in the file; `docker compose up -d --no-deps --wait <svc>` |
| Bad release is live | Gate tripped and rollback compatible? Roll back now; otherwise flag off or forward-fix; capture evidence; hand off to incident-response |
| Release ran a destructive migration | Do not roll code back blindly; test vN-1 against the current schema; forward-fix or follow a restore plan with backup-recovery |

## Patterns and pitfalls

- **Pod-template-only undo** — `kubectl rollout undo` reverts the pod template; config changed alongside stays new. Version config with hashed or immutable ConfigMap names so it rolls with the template.
- **GitOps reverts your revert** — Argo CD or Flux auto-sync reapplies the newer spec after an imperative undo; roll back in Git or pause sync deliberately.
- **Migrations ahead of code** — pipelines often migrate before rollout; if the rollout fails the schema is already vN, so vN-1 must tolerate it.
- **Static asset skew** — cached HTML from either version requests its own hashed chunks; keep both versions' assets through the transition.
- **Cache and session formats** — vN entries that vN-1 cannot deserialize crash the rollback; prefix cache keys with a format version.
- **Queue payload skew** — old workers meet new messages during rollback; keep new fields optional until every consumer runs vN.
- **Under-powered canaries** — a 1% slice for ten minutes cannot detect a 0.5-point error increase; size traffic and window to the threshold, or add synthetic checks.
- **DNS-based switches** — TTLs and resolver caching make both cutover and rollback slow; prefer load balancer weights or a router-level switch.
- **Clients you cannot roll back** — mobile and desktop builds keep calling the newer API; the server must keep that contract after a server rollback.
- **Irreversible side effects** — emails, webhooks, charges and third-party writes during exposure need reconciliation, not a rollback.
- **Pruning inside the window** — release cleanup or registry retention that deletes vN-1 removes the rollback target.

## Workflow

1. Capture the current tuple and health baseline; confirm the rollback artifact still exists.
2. Check compatibility across schema, payloads, caches and assets (reference §2); mark anything that makes rollback unsafe.
3. Rehearse promotion and rollback in staging with the exact commands; time the rollback.
4. Promote progressively; watch gates per version for the agreed window.
5. On a tripped gate, roll back with the recorded command and verify vN-1 identity and recovery.
6. Report versions, gate results, exposure window and the state written by vN that needs reconciliation.

## Proof

- Identity: `curl -fsS https://app.example.com/version` returns the expected SHA; `kubectl get deploy <name> -n <ns> -o jsonpath='{.spec.template.spec.containers[*].image}'`; `readlink -f /srv/app/current`; `wrangler deployments list`
- Rollout: `kubectl rollout status deploy/<name> -n <ns>`, `helm status <release> -n <ns>`
- Gates: error rate and latency per version label from the monitoring system across the window; a synthetic journey on the live domain
- Rollback rehearsal: staging run of the exact command with measured time to healthy vN-1

## Stop and ask

- Any production traffic shift, promotion or rollback.
- A rollback across a schema change or after irreversible external side effects.
- Pausing GitOps sync or CI auto-deploys.
- Deleting releases, images or versions that are inside the rollback window.

## Before returning

- [ ] vN-1 and vN tuples (SHA, digest or version ID, config and schema revision) recorded
- [ ] Schema, payload, cache and asset compatibility checked in both directions; unsafe cases listed
- [ ] Gates, thresholds, window and exact rollback command written and rehearsed
- [ ] Single deployment writer confirmed; auto-deploy or sync state noted
- [ ] Live version identity and gate signals observed after promotion or rollback
- [ ] Irreversible side effects and data written during exposure reported for reconciliation

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Cloudflare deployment versions](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/), [Kubernetes deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/).

## Skills in scope

- ci-cd — build and repair reproducible CI and deployment workflows with explicit artifacts, permissions and release gates.
- vps-deploy — deploy an owned application to an explicitly authorized VPS with versioned artifacts, service identity and live health evidence.
- database-migrations — design and verify schema migrations, bounded backfills and deployment compatibility for databases.
- incident-response — when a bad release is an active outage that needs coordinated mitigation.
- kubernetes-operations — rollout history, Helm revisions and GitOps-owned workloads.
- cloudflare-workers — Worker versions, gradual deployments and rollback limits.
