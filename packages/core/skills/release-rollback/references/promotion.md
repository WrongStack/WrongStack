# Release Promotion & Rollback Runbook

## 1. Immutable Release Record

Before shifting any production traffic, record the complete transition tuple:

| Field | Current (`vN-1`) | Candidate (`vN`) |
|---|---|---|
| Source Git SHA | `<sha-prev>` | `<sha-next>` |
| Artifact / Image Digest / Version ID | `<digest-prev>` | `<digest-next>` |
| Config / Secret Revision | `<cfg-prev>` | `<cfg-next>` |
| Database Schema Revision | `<mig-prev>` | `<mig-next>` |
| Rollback Command | `<exact command to restore vN-1>` | — |

Keep a single deployment writer active at all times; pause automated CI/CD deploy pipelines before executing a manual promotion or rollback.

## 2. Pre-Promotion Compatibility Matrix

Verify five overlap boundaries whenever `vN-1` and `vN` run concurrently (rolling update, canary, blue/green) or if `vN` must roll back to `vN-1`:

1. **Database Schema (Expand & Contract)**: Can `vN-1` still `SELECT`, `INSERT`, and `UPDATE` against the database after `vN`'s migration runs? Any column rename, `NOT NULL` addition without a default, or column drop breaks `vN-1` immediately.
2. **Queue & Event Payloads**: Can an older `vN-1` worker consume a job enqueued by `vN` (during rollback), and can a `vN` worker consume in-flight jobs enqueued by `vN-1` (during promotion)? Treat new payload fields as optional until `vN-1` is fully drained.
3. **Cache & Session Serialization**: Are Redis/KV keys and session tokens written by `vN` readable by `vN-1` without deserialization crashes? Version cache key prefixes when wire formats change incompatibly.
4. **Static Assets & Client Skew**: Browsers holding cached `vN-1` HTML will request `vN-1` hashed JS/CSS chunks after `vN` goes live; retain both versions' static assets on the CDN/origin throughout the transition window.
5. **Irreversible External Side Effects**: Outbound webhooks, emails, billing charges, and destructive data migrations cannot be undone by switching container images.

## 3. Progressive Promotion & Gate Observation

1. Deploy `vN` to staging or a non-traffic-bearing production slot/version (`wrangler versions upload`, green deployment, or canary pod) and verify startup + readiness probes.
2. Shift traffic progressively (or execute rolling update with `maxUnavailable: 0` and `preStop` drain delay) while watching objective SLIs across a defined window:
   - HTTP `5xx` and unexpected `4xx` error rates.
   - p95 / p99 request latency and upstream database pool saturation.
   - Background job failure/retry rates and consumer lag.
   - Real end-to-end synthetic user journey on the live domain.

## 4. Rollback Execution & Post-Rollback Reconciliation

1. If an abort threshold is breached and rollback is authorized, switch immediately to the pre-built `vN-1` artifact digest / version ID (`kubectl rollout undo deployment/<name> --to-revision=<rev>`, `helm rollback <release> <rev> --wait`, `wrangler rollback <version-id>`, a Git revert under GitOps, or an atomic symlink switch)—never wait for a fresh CI rebuild of old source code.
2. Confirm that live instances report `vN-1` identity and that error/latency SLIs return to baseline.
3. Reconcile any state written by `vN` during the exposure window separately (failed jobs in DLQ, partial records, or forward schema repair); never claim that rolling back code automatically repaired mutated data.

## 5. Rollback-Unsafe List (decide before promotion)

Write down, before traffic moves, every change that makes "switch back to `vN-1`" wrong, and the alternative for each:

| Change in `vN` | Why rollback is unsafe | Alternative |
|---|---|---|
| Column/table drop, rename, type narrowing | `vN-1` queries fail immediately | Feature flag off, forward fix, or restore plan |
| New enum value or payload shape already written | `vN-1` deserializers crash on new rows/messages | Ship tolerant readers in `vN-1` first, or drain and forward fix |
| One-way data backfill or re-encryption | Old code cannot read the new representation | Keep dual-read until the rollback window closes |
| External side effects (emails, charges, webhooks) | Cannot be unsent | Reconcile; consider kill switch before full exposure |

Sources: [Kubernetes Deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/),
[Cloudflare versions](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/).
