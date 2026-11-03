# Desktop, CLI, and operations specification

Status: proposed product behavior. UI labels and documentation are English.

## 1. Desktop responsibilities

The desktop application displays daemon state and sends authorized management requests. It does not open index databases directly and does not retain daemon credentials in browser storage. Tauri's Rust side uses the shared IPC client; the WebView receives typed view models and scoped commands.

The main desktop window can close while indexing continues. A small tray shell may remain, but quitting that GUI shell also leaves the daemon running. "Quit Desktop" and "Stop Index Service" are separate actions. Tauri supports native tray integration; implementation still requires lifecycle tests for the packaged application. [Tauri system tray](https://v2.tauri.app/learn/system-tray/)

## 2. Information architecture

```text
Sidebar
  Overview
  Projects
  Activity
  Diagnostics
  Settings

Project detail
  Summary | Files & Errors | Jobs | Index Health | Configuration
```

Global header: connection state, daemon version, active/queued projects, and service actions. Never show an unconnected GUI's cached values as live health.

### 2.1 Overview

Required cards:

- Service running/reconnecting/stopped, version, instance uptime.
- Watching / indexing / pending / degraded / unavailable project counts.
- Aggregate CPU and RSS, queue depth, and active parser slots.
- Recent completed/failed jobs and actionable project errors.
- First-use "Add Project" action when no projects exist.

Project table columns: name/root, watch policy, backend, activity, freshness, watch health, last verified, last changed, pending paths, index size, and error indicator. Support sorting/filtering and keyboard navigation. Large project lists use virtualization only when measured need justifies it.

Freshness colors need text/icons; color alone is insufficient. "Last verified" and "Last changed" have different meanings and remain separate.

### 2.2 Add project

Flow:

1. Choose a local folder using the native picker or paste a path.
2. Resolve root and show detected checkout and proposed existing index directory.
3. Detect duplicate registration, missing root, unsupported storage, or ownership conflict.
4. Choose session/manual/pinned policy; manual GUI additions default to manual unless the user selects continuous watching.
5. Show "Use existing WrongStack index" when compatible, including the current owner and required adapter floor.
6. Validate and register; display durable job admission separately from completed indexing.
7. Open the project detail view with live progress and usable prior-generation status if available.

Do not automatically scan every folder on the machine. An optional import screen may enumerate existing WrongStack registrations after the user selects import; never pin them all by default.

### 2.3 Project summary

Show actual checkout path, index directory, profile, backend, owner, watch policy, watcher backend, current epoch/generation, last successful verification, last content change, counts, SQLite/WAL size, pending work, and latest actionable error.

Progress must reflect phases: discovering, reading/parsing, resolving, committing, and reconciling. A changing discovery total should display an indeterminate phase rather than a misleading percent. Differentiate skipped unchanged files, parsed files, empty successes, failures, and deletions.

Actions:

| Action | Behavior |
|---|---|
| Pause watching | Stops observation/work after safe drain; index retained; freshness no longer current |
| Resume watching | Reattaches and reconciles |
| Pin / Unpin | Persists policy; unpinning respects remaining active sessions |
| Reconcile | Verifies disk/index agreement without unconditional forced parsing |
| Rebuild index | Explicit maintenance workflow with ownership, backup/preservation, progress, and cancel semantics |
| Retry failed files | Re-enqueues visible failures without pretending a full rebuild is required |
| Open folder | Native OS folder-open action with validated path |
| Remove registration | Detaches service; source/index preserved by default |
| Export diagnostics | Redacted bounded bundle with preview of included categories |

Only actual destructive maintenance needs a clear confirmation dialog explaining the concrete effect. Ordinary pause/resume/reconcile actions do not require repeated confirmations.

### 2.4 Files and errors

List file outcome, parser/backend, last good index time, error category, retry state, and affected freshness. Search/filter by path, language, and outcome. Avoid loading source content merely to show an error list.

Each error provides a plain next action: restore folder, fix access, update compatible client, free disk space, retry, or inspect diagnostics. Repeated identical failures aggregate counts. Recovered errors remain in bounded history but no longer color the project as currently broken.

### 2.5 Jobs and activity

Display job ID, cause, project, requested scope, admitted/started/completed times, backend, phase, result generation, changed/parsed/skipped/failed counts, and cancellation outcome. Users can distinguish "request accepted" from "index ready".

Activity is a bounded projection of daemon job/events, not a second source of truth. Reconnect fetches a snapshot and job outcomes; it does not replay thousands of raw watcher messages into the UI.

### 2.6 Index health

Show schema/profile compatibility, effective SQLite features, integrity-check result/time, source verification status, rank/concept/vector freshness, and checkpoint state. Health checks are real jobs with timestamps and scope; a green process heartbeat is not a database integrity check.

Optional search inspector: query, filters, results, generation, stale/fresh indicator, and basic symbol location. It is a diagnostics aid, not an editor or a replacement for the full WrongStack Code Atlas in 1.0.

### 2.7 Settings

Settings groups:

- Startup: start daemon at user login, launch desktop UI separately, close-to-tray preference.
- Resources: global parser/full-scan concurrency, memory budget, staged data cap, battery behavior.
- Watch defaults: session lease/grace, debounce, polling fallback, reconciliation intervals.
- Storage: data root, log retention, backup retention; active-root relocation requires a controlled restart/migration.
- Privacy: diagnostics contents, optional network/enrichment status; no telemetry by default.
- Updates: installed versions, update channel, signing status, download/install controls.

Validate ranges and explain pending-restart settings. Applied configuration revisions are acknowledged by the daemon before the GUI reports success. A failed save must not leave the UI displaying an unapplied policy.

## 3. Tray menu

Proposed menu:

```text
WrongIndex — Watching 4 projects
Open WrongIndex
Recent Projects >
Pause Background Indexing
Resume Background Indexing
Service Status
Quit Desktop
Stop Index Service...
```

Pause and stop differ: pause preserves service/query availability; stop disconnects clients and ends indexing after drain. Use accessible text and a visible global paused state. Rate-limit desktop notifications; only sustained actionable failures warrant them, not each edit or successful index run.

## 4. CLI surface

These are proposed commands, not commands available in the current repository:

```text
wrongindex daemon start|status|stop|restart
wrongindex project add <root> [--index-dir <path>] [--watch session|pinned|manual]
wrongindex project list [--json]
wrongindex project status <id> [--json]
wrongindex project pin|unpin|pause|resume <id>
wrongindex project remove <id>
wrongindex index <id> [--reconcile|--rebuild] [--wait] [--json]
wrongindex search <id> <query> [--limit <n>] [--json]
wrongindex job status|cancel <job-id>
wrongindex doctor [--project <id>] [--json]
wrongindex diagnostics export [--project <id>] --output <path>
wrongindex autostart enable|disable|status
```

Rules:

- Machine-readable stdout contains JSON only when requested; diagnostics go to stderr.
- Exit codes distinguish success, invalid input, unavailable service, incompatible profile, job failure, and timeout.
- Without `--wait`, indexing returns a durable job ID; with `--wait`, wait until terminal state with a configurable deadline.
- Ctrl+C cancels the client's wait by default; canceling a durable job is explicit.
- CLI never falls back to writing SQLite just because a pipe request timed out.
- `doctor` is read-only by default; repair is a separately named operation.
- No token appears in process arguments or output.

## 5. Configuration draft

Illustrative TOML; implementation must validate names and ranges:

```toml
schema_version = 1

[startup]
daemon_at_login = false
desktop_at_login = false

[resources]
parser_slots = 4
concurrent_full_scans = 1
memory_budget_mib = 512
staging_budget_mib = 2048

[watch]
debounce_ms = 400
coalesce_ms = 50
max_burst_wait_ms = 2000
max_dirty_paths_per_project = 10000
reconcile_interval_seconds = 900
deep_verify_interval_seconds = 86400
poll_interval_seconds = 5

[session]
heartbeat_seconds = 15
lease_seconds = 60
last_client_grace_seconds = 120

[diagnostics]
log_level = "info"
log_total_mib = 50
job_history_days = 7
backup_count_per_project = 2
```

Do not force parser_slots=4 on a single-core machine; the resolved default uses detected resources. Memory and staging budgets are admission targets, not a claim that an OS will enforce a hard allocation limit. Define degradation/refusal when measured usage exceeds budget.

Precedence: compiled defaults < global user config < explicit per-project policy < supported explicit CLI override for that request. GUI and WrongStack adapters write through the same configuration API. Profile/migration/ownership invariants cannot be bypassed by an ordinary setting.

## 6. Observability

Structured event fields: timestamp, severity, daemon instance, project ID, job/run ID, phase, backend, profile, duration, counts, generation, error code, retry count. Full source text and authentication material are forbidden in normal logs.

Metrics:

- Daemon RSS/CPU/thread count and uptime.
- Active projects/watch handles/read connections/parser slots.
- Event rate, dirty set size, queue wait, overflow/reconcile count.
- Time from observed edit to committed usable generation.
- Discovery/read/hash/parse/resolve/rank/commit durations.
- Parsed/skipped/failed/deleted files, changed symbols/refs.
- Query p50/p95/p99, canceled/timeout counts, stale responses.
- WAL size/checkpoint lag, database bytes, staging and backup bytes.
- Parser crash/restart counts in preview, project circuit state.

Initial metrics are local and available through IPC/diagnostics; no public HTTP metrics port is required. High-cardinality file paths are not metric labels. Debug logging can include sanitized local paths by explicit choice with retention bounds.

## 7. Installation and autostart

First target: Windows x64 per-user installation. ARM64 and other operating systems require their own build/test matrix before support is claimed.

Installer responsibilities:

1. Install matching daemon, CLI, GUI, protocol/profile manifests, grammar assets, and preview worker if applicable.
2. Verify package checksums/signature status and record installed version.
3. Register optional user-login daemon startup without requiring administrator privileges.
4. Keep GUI auto-launch separate from headless startup.
5. Validate the installed daemon can start without a source checkout, Bun, or Node for native release.
6. Register uninstall behavior and preserve user/source indexes by default.

Windows may use a per-user startup mechanism or scheduled task chosen during packaging spike. Linux user services and macOS LaunchAgents are later platform-specific work; do not ship a privileged Windows service merely to achieve persistence.

## 8. Updates and rollback

Update protocol: download/verify -> negotiate clients/profile -> stop new jobs -> drain -> stop old daemon -> replace binaries safely -> start new daemon -> recover/reconcile -> reconnect clients. Windows file replacement needs installer/updater coordination. Never overwrite the running executable and assume it succeeded.

Keep a compatible previous binary for rollback if supported. Binary rollback and data rollback are different operations; a new index/registry profile may not be readable by the old binary. Publish that compatibility before offering rollback. Desktop and daemon mismatches are visible typed errors, not restart loops.

An update that fails before activation retains the previous working installation. A failed migration retains a consistent backup and recovery state. Automatic updates must not silently rebuild or delete current WrongStack indexes.

## 9. Accessibility and desktop quality

- Complete keyboard navigation with visible focus and logical tab order.
- Screen-reader labels for state, progress, errors, and icon actions.
- Contrast tested for light/dark themes; no status conveyed only by color.
- Text scaling and Windows DPI/multi-monitor behavior.
- Long path handling without hiding the distinction between checkout and index directory.
- Reduced motion; animated progress does not imply actual file throughput.
- Empty, connecting, reconnecting, service-missing, conflict, degraded, and stopped screens.
- Tauri mock IPC can cover views, but packaged WebView/daemon lifecycle requires real native smoke.

## 10. Operational runbooks to ship

Create concrete runbooks for: service cannot start; incompatible WrongStack client; ownership conflict; project missing; watcher degraded; queue backlog; parse failures; WAL growth; disk full; interrupted update; database corruption; safe rebuild; restore backup; release ownership; uninstall; and collect redacted diagnostics.

Every runbook begins with a read-only diagnosis command and states which operations mutate data. Avoid generic "delete the database" advice when stored concepts/vectors or another owner may be present.
