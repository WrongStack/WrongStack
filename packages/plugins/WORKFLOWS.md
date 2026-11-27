# Deterministic workflow plugins

These 24 opt-in plugins follow the agreed implementation order below. Enable an
individual plugin with `{"plugins":[{"name":"bug-reproducer","enabled":true}]}`.
The extension-level `enabled` option defaults to true once a plugin is loaded.
No workflow runs at startup. Generated website detail pages list the tools and
their input parameters; `PLUGIN_CATALOG.md` lists the importable entry points.

Commands use `{program,args,cwd?,timeoutMs?}` rather than shell command strings.
Command execution, browser journeys, HTTP mutations and journal writes use the
normal tool confirmation policy. Paths resolve against the calling project's
root and follow symlinks for containment checks. Reload/teardown cancels work;
state is isolated by loaded host and project.

## Workflows, in implementation order

| # | Plugin / primary tool | Input and concrete output |
|---|---|---|
| 1 | `bug-reproducer` / `bug_reproduce` | Run an explicit regression `command` twice against `files` (default: the working-tree change), requiring an `expectedOutput` literal to attribute failure. Return reproduction status, hashes, both executions and a Node regression test recipe. The caller supplies the initial reproducer; this does not synthesize one from prose. |
| 2 | `verification-ledger` / `verification_record`, `verification_status` | Execute a labeled check against `files` (default: the working-tree change), retain hashes, and recompute freshness on status. Records are host-session/project-local; restart clears them. Include every relevant source/config/lockfile in `files`. |
| 3 | `acceptance-verifier` / `acceptance_verify` | `criteria:[{id,requirement,command?,files?}]` produces one measured result per requirement. Missing commands stay unverified. Empty criteria and duplicate ids are rejected. |
| 4 | `runtime-trace-explorer` / `runtime_trace_explore` | Read `path` containing `{spans:[{id,parentId?,traceId,layer,startMs,endMs,status}]}`; select `traceId` and optional required `layers`. Report parent cycles, errors, invalid timing and missing layers. This consumes instrumentation exports; it does not instrument an application. |
| 5 | `workspace-recipe-runner` / `workspace_recipes`, `workspace_recipe_run` | Inspect a package.json `path` (default: root `package.json`) for scripts, package manager, engines and workspace dependencies; execute a selected structured command separately. |
| 6 | `architecture-boundary-checker` / `architecture_boundaries` | Inspect `files` (default: up to 3000 project source files) with forbidden `{from,to}` directory pairs. Return literal import edges, cycles, violations and unresolved imports. Computed imports/aliases need compiler-backed follow-up; literal matching may include comments. |
| 7 | `monorepo-change-planner` / `monorepo_change_plan` | Given package `manifests` (default: the declared workspace packages) and `changedFiles` (default: the working-tree change; a clean tree plans nothing), compute transitive consumers and dependency-first build/test order. Publication candidates remain subject to release policy. Unattributed root changes are explicit. |
| 8 | `config-migration-assistant` / `config_migration_preview` | Preview explicit top-level `{from,to}` renames and missing-key `defaults` for JSON `path`. Preserve customized values and reject destination conflicts. Returns JSON for review; no file is written. |
| 9 | `feature-flag-lifecycle` / `feature_flag_inventory` | Match declared `flags:[{name,expiresAt?,owner?}]` against `files` (default: up to 3000 project source files); return references, expiry and flags unused in the supplied scope. Literal matches do not prove branch reachability. |
| 10 | `generated-artifact-tracker` / `generated_artifacts` | `rules:[{id,inputs,outputs,command}]` with `action:capture/check`. Compare source/output fingerprints against a caller-approved session baseline. Capturing a baseline does not prove the generator ran. |
| 11 | `api-consumer-replay` / `api_consumer_replay` | Loopback `baseUrl` plus `cases:[{path,method?,body?,expectedStatus,expectedJson?}]`. Execute HTTP requests and compare status/selected top-level JSON fields. Redirects are not followed. |
| 12 | `migration-rehearsal` / `migration_rehearse` | Execute `seed`, `up`, optional `down` SQL files in a fresh in-memory SQLite child process. Return schema/data snapshots and rollback equivalence. Requires Node with `node:sqlite`; PostgreSQL/MySQL and production locking are outside this implementation. |
| 13 | `failure-injection-lab` / `failure_inject` | Replace `{faultUrl}` in command argv with a temporary local endpoint. Inject `rate-limit`, `malformed-json`, `disconnect` or `delay`. Success requires endpoint use and a passing test command; recovery assertions belong in that test. |
| 14 | `concurrency-scenario-tester` / `concurrency_test` | Issue `count` concurrent requests to a loopback `url`, compare `expectedSuccesses`, and optionally verify `invariant:{url,expectedJson}`. This exercises HTTP concurrency; it does not control internal thread scheduling. |
| 15 | `resource-lifecycle-inspector` / `resource_lifecycle_inspect` | Import local ESM `fixture` exporting `start()` and `stop(handle)`; run `cycles`, then compare active Node resources against baseline. Does not detect arbitrary heap/native leaks. |
| 16 | `visual-regression-reviewer` / `visual_regression_compare` | Compare `baseline` and `current` PNG pixels with channel `tolerance` and `maxChangedPixels`. Return changed ratio and bounding rectangle. Supports non-interlaced 8-bit RGB/RGBA; font/animation normalization is caller-owned. |
| 17 | `responsive-journey-tester` / `responsive_journey_test` | Run loopback `url`, `viewports:[{width,height}]`, `steps:[{action,selector,value?}]` and required `selectors` in Chromium. Actions: click/fill/press. Report overflow and visible/reachable controls. Requires project-local `playwright` or `@playwright/test` and an installed Chromium binary; no implicit downloads. |
| 18 | `localization-completeness` / `localization_compare` | Compare nested JSON `base` against `locales:{language:path}`. Report missing/extra/empty keys and interpolation mismatches. Explicit plural keys are supported; full ICU grammar and CLDR validation require the project i18n compiler. |
| 19 | `executable-documentation` / `documentation_verify` | Execute only Markdown fences marked `js verify` or `javascript verify` in `path` (default: `README.md`). Return source lines and actual Node exit results. Example authors supply meaningful assertions. |
| 20 | `dependency-upgrade-sandbox` / `dependency_upgrade_try` | Copy explicit `files` including package.json into a temporary directory, change a declared `dependency` to exact `version`, install with npm `--ignore-scripts`, run `checks`, remove the temporary copy. Standalone npm fixtures only; no workspace protocol. Directory isolation is not an OS security boundary. |
| 21 | `developer-environment-doctor` / `developer_environment_check` | Read `manifest` (default: root `package.json`), probe Node and the declared package-manager version, and check node_modules. Report engine declarations without pretending to validate arbitrary semver expressions or native ABI compatibility. |
| 22 | `service-topology-inspector` / `service_topology_inspect` | Probe `services:[{name,url,dependsOn?}]` health endpoints on loopback, report unhealthy/missing dependencies and cycles. Does not start services. |
| 23 | `decision-journal` / `decision_record`, `decision_lookup` | Append explicit `title`, `rationale`, `files`, optional `supersedes` to a project `journal` JSONL file. Retrieve related decisions by `files` (default: the working-tree change), preserving supersession history. This is the durable workflow store; other ledgers are session-local. |
| 24 | `plugin-workbench` / `plugin_workbench_run` | Load built ESM plugin `path` in a bounded child with mocked host APIs, setup twice and teardown. Report tool registration and leaked hooks. It executes plugin code with normal user permissions; production-host integration still needs host tests. |

## Defaulted inputs

Inputs the project already knows may be omitted. The working-tree change is
read with read-only `git diff HEAD --name-only` plus untracked files under the
repository isolation environment; workspace packages come from
`package.json` `workspaces` or `pnpm-workspace.yaml`; source walks skip build,
vendor and dot directories. Every resolved path must stay inside the project
root. A default that cannot be computed (not a git repository, a clean tree
where changes are required) fails with an error instead of running on an empty
scope, and results name the source they used (`inputs`, `filesSource`).

## Optional model advice

`bug_reproduce` and `monorepo_change_plan` accept `review: "none"` (default),
`"one-shot"` or `"council"`. Calls use the host's plugin LLM facade and existing
Council/One Shot fallback helpers. Replies must validate as a bounded
`{suggestions:string[]}` object. Missing providers, invalid responses and outages
leave deterministic results intact and return a fallback reason. Model advice
cannot turn a failed check into a pass. No JEV integration is claimed here.

## Example: prove a bug and track its correction

```json
{
  "command": {"program":"node","args":["--test","tests/checkout.test.mjs"]},
  "files":["src/checkout.mjs","tests/checkout.test.mjs","package.json"],
  "expectedOutput":"checkout preserves the cart",
  "review":"none"
}
```

After correcting the bug, call `verification_record` with the same command and
files plus `label:"checkout regression"`. `verification_status` reports `stale`
when any listed file changes. A pass covers only the listed command, file scope
and execution environment; it is not a release-wide certificate.
