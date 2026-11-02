---
name: incident-response
description: "Production incidents: outages, 5xx spikes, latency, bad deploys, saturation, expired certs; triage, mitigation, rollback and timeline. Use when a live service is down or degraded, alerts are firing, a deploy just broke something, or a postmortem needs a verified timeline. Not for host forensics on its own (use remote-debugging) or planned releases (use release-rollback)."
trigger: "Use when production is down, degraded or alerting and someone must stabilize it, find what changed and record what happened."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: operations
  domain: "operations"
---

# Incident Response

## Selection card
- Task: Stabilize a degraded or down service, then establish what happened.
- Start: Write the impact statement (what users see, since when in UTC, who is affected) and list every change in the last 24 hours: deploys, config, flags, migrations, certificates, provider status.
- Finish: the user-facing signal has been at baseline for the agreed window, the mitigation and its reversal are recorded, and the timeline separates confirmed facts from hypotheses.

## Overview

Stabilize first and explain later: restore the user-facing signal with the smallest reversible action the evidence supports, while keeping the evidence the root-cause analysis will need.
Use current deployed versions, platform limits and actual telemetry. Stored runbooks and prior incidents guide hypotheses but do not prove this incident cause.
Most incidents correlate with a change; the fastest question is "what changed, and when, relative to onset?"

## Rules

1. State impact in user terms with a UTC onset and one SLI (error rate, p99 latency, synthetic journey success). Severity follows user impact, not alert volume.
2. One incident commander and one mutation owner; every command and change is logged with a UTC timestamp. Freeze automated deploys so CI and humans do not fight.
3. Check changes before theories: deploys, config, secrets, feature flags, migrations, traffic shifts, cron jobs, dependency status pages, and certificate, DNS or quota expiries.
4. Prefer reversible mitigations: roll back the change, disable the flag, shed or shift traffic, scale out, fail over. Write hotfix code only when nothing reversible exists.
5. Capture cheap volatile evidence before a restart (bounded logs, previous-container logs, running version, active DB queries); for a full outage decide explicitly that mitigation outranks forensics.
6. Before rolling code back, check data compatibility: an older version reading a new schema, enum or payload can turn degradation into a crash loop.
7. Verify recovery with the user SLI and downstream backlogs (queue depth, DB load, error budgets), not liveness, and watch for a sustained window.
8. Communicate facts on a cadence, redact secrets and PII, and run a blameless review with owned action items.

## First moves by situation

| Situation | First moves |
|---|---|
| 5xx after a deploy | Align deploy time with onset; `kubectl rollout history deploy/<name> -n <ns>` or the platform's version list; roll back to the recorded prior version if authorized |
| Latency up, no deploy | Saturation per layer (CPU, memory, connection pools); `pg_stat_activity` non-idle queries by duration; `pg_blocking_pids(pid)` for lock chains; upstream status pages |
| Some users or one region | DNS, CDN and LB target health, a single AZ, tenant-specific data, a flag cohort, a partially completed rollout |
| TLS or handshake errors | `openssl s_client -connect host:443 -servername host </dev/null 2>/dev/null \| openssl x509 -noout -dates -issuer`; check the chain and clock skew (`timedatectl`) |
| Writes failing, disk full | `df -h`, `df -i`, `du -xh /var --max-depth=2 \| sort -h \| tail`; unrotated logs; never delete database or WAL files to free space |
| Crash loop or OOM | `kubectl describe pod`, `kubectl logs --previous`, host `journalctl -k \| grep -i oom`; recent memory or traffic change |
| Dependency recovered, service still down | Retry storm or cold caches: queue backlog, pool exhaustion; shed load, lower concurrency, re-admit gradually |
| Wrong or corrupt data being written | Stop the writer (flag off, scale the worker to zero) to bound damage; snapshot; hand off to backup-recovery |
| Possible security incident | Preserve evidence, isolate, involve the security owner; do not wipe or rebuild before capture |

## Patterns and pitfalls

- **Delayed causes** — a deploy hours earlier can still be the trigger through cache TTL expiry, a cron run, a gradual rollout reaching 100% or a daily traffic peak.
- **Metastable failure** — after the trigger is gone, client retries, cold caches and queued backlog keep the system saturated; jittered backoff, admission limits and staged re-enablement end it.
- **Restart side effects** — restarting every replica at once wipes evidence and causes a cold-cache, connection-storm thundering herd; restart in rolling batches.
- **Lying health checks** — `/healthz` returns 200 while checkout fails; verify with the real journey. Liveness probes that query the database restart the whole fleet during a DB blip.
- **Clock skew** — JWT `nbf`/`exp`, TLS validity and signed URLs fail on a drifting host; `chronyc tracking` or `timedatectl` early in auth incidents.
- **Expiry inventory** — certificates, domains, API keys, OAuth client secrets and license or quota periods expire on schedules nobody watches; check them when nothing changed.
- **Partial rollouts** — canary or gradual deployments mix versions; break error rates down by version label before blaming the whole release.
- **Silenced alerts** — silences and temporary limit raises outlive the incident unless time-boxed and listed for stand-down.
- **Hypothesis lock-in** — keep a ruled-out list with the evidence that ruled each out; the first plausible story is often wrong.

## Workflow

1. Declare: severity, commander, channel or document, impact statement, UTC onset.
2. Triage outside-in (DNS/CDN → LB → app → data stores and dependencies) and correlate with the change list to narrow the failing boundary.
3. Choose a mitigation with an abort condition; capture quick evidence; the mutation owner executes and logs it.
4. Verify SLI recovery and backlog drain; observe a sustained window at normal traffic.
5. Stand down: revert temporary measures (flags, limits, silences, frozen pipelines) deliberately or ticket them.
6. Write the review: timeline, contributing factors, detection gap, what helped, owned actions; facts and hypotheses separated.

## Proof

- Synthetic journey: `curl -fsS -o /dev/null -w '%{http_code} %{time_total}\n' https://example.com/<critical-path>` repeated across the window
- Kubernetes: `kubectl rollout status deploy/<name> -n <ns>`, `kubectl get events -n <ns> --sort-by=.lastTimestamp`
- Host service: `systemctl status <unit>`, `journalctl -u <unit> --since "-15min" -p warning --no-pager`
- Database: non-idle query count and longest duration back to baseline; connections below `max_connections`
- Metrics: error rate and p99 at the pre-incident baseline in the monitoring system for the agreed window
- Queues: depth and consumer lag trending to zero

## Stop and ask

- Any data-mutating step: manual SQL repair, restore, deleting queue messages, purging caches with side effects.
- Database or region failover, DNS changes, or a rollback across a schema or payload change.
- Actions on systems outside the responder's authorized scope or owned by another team.
- Credential rotation, customer-facing communication, or disabling a security control to restore service.

## Before returning

- [ ] Impact statement, UTC onset, SLI and change list recorded
- [ ] Mitigation executed by a single owner within authorized scope, with abort condition and timestamps
- [ ] Volatile evidence captured, or the decision to skip it recorded
- [ ] User-facing SLI and downstream backlogs verified at baseline over a sustained window
- [ ] Temporary measures listed with reversal owners
- [ ] Timeline separates confirmed facts, ruled-out hypotheses and unknowns; no secrets or PII in the record
- [ ] Follow-up actions owned, including the detection or alerting gap

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[OpenTelemetry](https://opentelemetry.io/docs/), [Google SRE incident guidance](https://sre.google/sre-book/managing-incidents/).

## Skills in scope

- observability — SLI/SLO dashboards, log/trace correlation, and high-signal alert triage during outages.
- remote-debugging — diagnose a reported application failure on explicitly authorized remote hosts using bounded logs and runtime evidence.
- release-rollback — plan and execute authorized release promotion or rollback with exact artifact and data compatibility.
- backup-recovery — design and verify backups and restoration for owned databases, files and application state.
- kubernetes-operations — pod triage, rollout history and rollback on clusters.
- internal-comms — status updates and the blameless postmortem write-up.
