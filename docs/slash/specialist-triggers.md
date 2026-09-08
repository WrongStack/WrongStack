# `/specialist-triggers` — wake roster specialists on file patterns

`/specialist-triggers` is registered by the `wstack-specialist-triggers` plugin. The command is always available so the feature is discoverable, but **nothing fires until `enabled` is explicitly `true`** — this plugin spawns agents that cost money without anyone asking for them, so the default is off.

## The problem it addresses

The roster carries 75 specialists. Measured over August–September 2026, `reviewer` took roughly nine spawns in ten, and a dozen roles had never been spawned at all. The 2026-08-10 work established that this is *not* a routing failure — the dispatcher picks well once it is consulted. The gap is upstream: `reviewer` is the only role anything asks for automatically. Every other specialist waits for a leader to remember it exists.

Auto-review is the machine that makes `reviewer` busy. This plugin is the same machine, generalised to a handful of cases where "this file changed, therefore that specialist has work" needs no judgement at all.

## What fires what

Shipped rules (`DEFAULT_SPECIALIST_TRIGGERS` in `packages/core/src/plugins/specialist-trigger-rules.ts`):

| Role | Patterns |
|------|----------|
| `dependency` | `**/package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `**/requirements*.txt`, `**/Cargo.toml`, `**/go.mod` |
| `database` | `**/migrations/**`, `**/*.sql`, `**/schema.prisma` |
| `i18n` | `**/locales/**`, `**/i18n/**`, `**/*.ftl`, `**/messages/*.json` |
| `security-scanner` | `**/auth/**`, `**/*credential*`, `**/*secret*`, `**/.env.example`, `**/security/**` |
| `api` | `**/openapi*.{yaml,yml,json}`, `**/*.proto`, `**/*.graphql` |
| `devops` | `**/Dockerfile*`, `**/docker-compose*.{yaml,yml}`, `.github/workflows/**`, `**/*.tf`, `**/k8s/**`, `**/helm/**` |
| `e2e` | `**/e2e/**`, `**/cypress/**`, `**/playwright.config.*` |
| `performance` | `**/benchmarks/**`, `**/*.bench.{ts,js}` |
| `payments` | `**/payments/**`, `**/billing/**`, `**/*invoice*` |
| `ios` | `**/*.swift`, `**/Podfile`, `**/*.xcodeproj/**` |
| `android` | `**/*.kt`, `**/build.gradle{,.kts}`, `**/AndroidManifest.xml` |

Several are inert in any one repository — nothing here is written in Swift. That is intended: the plugin ships to every project, and a rule that costs nothing where it does not apply is worth having where it does.

Two tests a rule has to pass, and length is not one of them:

1. **The mapping needs no judgement.** A Dockerfile pointing at `devops` is a fact about the file, not an opinion about the change. Anything that needs a reading of *what* changed belongs to `dispatchAgent`.
2. **It cannot fire on ordinary source churn.** There is no `frontend` rule on `**/*.tsx`: in a repo whose TUI is React that fires every session, and a specialist that always has an opinion crowds the per-session cap out from under the rules that only speak when something genuinely happened.

Before shipping, the rules were scanned against this repository's 8632 tracked files. That caught three violations, all now fixed: a `document` rule matching 413 files, `**/*ledger*` claiming `brain-ledger.ts` for `payments`, and a bare `**/schema.ts` claiming every zod and JSON schema for `database`. **Run that scan before adding a rule** — `matchSpecialistTriggers(gitLsFiles, rules)` against your own tree, and read the counts. Note that `**` compiles to `.*` with no path boundary, so `**/schema.ts` also matches `metrics-schema.ts`.

Add a rule when the same specialist has been spawned by hand for the same file shape more than twice — `/fleet routing` shows which roles those are.

A path may wake several rules. A migration written under `auth/` genuinely concerns both the database and the security agent, and making them compete would hide one of the two findings.

## How it works

```
iteration.completed
  → git status --porcelain          (changed paths, INCLUDING untracked)
  → match paths against the rules
  → path set still moving?  restart the quiet window
  → path set settled?       emit fleet.specialist_needed
                              → CLI handler spawns the role + assigns the task
                              → result lands in the transcript as a 🔔 note
```

Untracked files count, unlike auto-review's scan. A brand-new migration or locale file is the normal shape of the work these rules watch for; a trigger that only saw modifications would miss the case it exists for. Ignored paths stay out either way, and `.wrongstack/` is skipped so agents writing their own bookkeeping cannot wake agents.

Detection lives in core and knows nothing about the fleet; spawning lives in `packages/cli/src/execution-specialist-trigger.ts`. A host with no Director simply never spawns and the plugin keeps working as a pure detector — the same split `chimera.review_needed` uses.

## What keeps it from running away

- **Fires once per path set.** The fire key is `role` plus the exact sorted path list. A file edited fifty times in one session wakes its specialist once; the set has to actually change before it fires again.
- **Quiet window.** `debounceMs` (default 20 s) so a half-written migration is not reviewed mid-edit.
- **Two caps.** `maxConcurrent` (default 2) and `maxPerSession` (default 8).
- **Bounded workers.** 30 iterations, 120 tool calls, 6-minute timeout, `budget` tier. Non-blocking, so a slower cheap model costs only wall-clock nobody is waiting on.
- **`spawnBudgetExempt`.** Triggered specialists do not consume the leader's lifetime spawn budget, which the user reserved for work they asked for.
- **Respects `/autonomy`.** A session that has switched subagents off fires nothing.
- **No retry ladder.** A background opinion whose model is down produces one line in the transcript, not a chain of failovers spending more money on an opinion nobody asked for.

The in-flight counter is released on a 10-minute TTL rather than on completion. The host that spawns may die or may not report back, and a counter that can only go up would silence the plugin for the rest of the session — a worse failure than one extra worker.

## Configuration

`config.json`, under `extensions["wstack-specialist-triggers"]`:

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `false` | Must be exactly `true`. |
| `rules` | shipped rules | Replaces the shipped set entirely. `[]` means no rules, not "use the defaults". |
| `extraRules` | `[]` | Appended to whichever set is in force. |
| `debounceMs` | `20000` | Quiet window before a settled set fires. |
| `maxConcurrent` | `2` | Specialists in flight from this plugin at once. |
| `maxPerSession` | `8` | Total triggers per session, across all rules. |

A rule is `{ role, match: string[], reason, tier? }`. `reason` is put verbatim into the woken agent's task, so write it as an instruction: the agent otherwise has to guess what about the change concerns it. Rules missing `role` or `match` are dropped rather than allowed to misfire.

```json
{
  "extensions": {
    "wstack-specialist-triggers": {
      "enabled": true,
      "extraRules": [
        {
          "role": "observability",
          "match": ["**/dashboards/**", "**/*.alerts.yaml"],
          "reason": "Alerting or dashboard config changed. Check that every alert has an owner and a runbook, that thresholds match the SLO they claim to defend, and that nothing now pages on a symptom nobody can act on."
        }
      ]
    }
  }
}
```

## Measuring whether it helped

`/fleet routing` reads `.wrongstack/agents/dispatch-log.jsonl`, which records every spawn's routing decision. Triggered spawns appear there as `explicit-role`, so the shape to watch is the count of distinct roles with spawns — that was 20 when this plugin was written, against 75 in the catalog.

Related: [`/fleet`](fleet.md), [`/auto-review`](auto-review.md), [`/autonomy`](autonomy.md).
