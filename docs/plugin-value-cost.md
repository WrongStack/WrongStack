# Plugin value and cost

The CLI decides whether a built-in plugin is enabled before importing its factory. The factory list and official specifiers remain in the generated catalog; a new plugin must be present in both. Unknown factory-list shapes fall back to the old post-import enablement check. This keeps disabled plugin implementation modules out of a normal session. The existing `config.plugins` and `config.extensions` precedence still applies.

The default official set is `secret-scanner`, `context-pins`, `error-lens`, `dep-guard`, `injection-shield`, and `adversary-mode` (which stays dormant at zero Brain/Jev/LLM cost until an `adversary.md` policy file exists or `alwaysOn` is enabled). Host infrastructure plugins use the same pre-import decision. An opt-in plugin imports only when enabled. No plugin tool runs merely because its factory was imported.

The ten evidence-analyzer plugins (`workspace-health`, `test-impact-analyzer`, `ci-failure-triage`, `env-contract-guard`, `dependency-drift-detector`, `release-readiness`, `bundle-budget-guard`, `public-api-auditor`, `lockfile-consistency-guard`, and `change-risk-classifier`) accept `review: "none" | "one-shot" | "council" | "jev"` on their tools. The default is `none`; no provider or Jev call occurs. Even when review is requested, zero findings skip the service. A review sends only finding labels, severity, line numbers and fixed rule advice, never raw evidence or excerpts. One Shot and Council return bounded JSON suggestions; Jev returns a validated choice among at most three findings and a defer option. Neither path changes findings or summary counts. Unavailable accounts, invalid responses and outages yield fallback reasons with the deterministic result intact.

One Shot and Council are intended for targeted next-check suggestions when findings need interpretation. Jev can prioritize an explicit finding when that choice changes the next check; its confidence is distribution concentration, not correctness. Running any of these on every log, every edit or clean analysis would add cost without improving the measured result. `api.jev` is available only to first-party plugins, resolves the existing account on demand, honors the `typesafe.judgments.tool` switch and tool restrictions, and records activity under `plugin:<name>`.

Plugin teardown aborts in-flight Jev work and prevents retained `api.jev` references from starting a later request. A cancelled or unavailable Jev result leaves the evidence analyzer's findings untouched.

The default-active `injection-shield` scans only the configured prefix of tool output. For array-form results, extraction now stops when that prefix is full instead of joining every content block first. Detection rules and the scan limit are unchanged.

`error-lens` keeps model hints disabled by default. When enabled, a new failure's hint call is limited to three seconds and follows the hook's abort signal. A late hint cannot update counters or replace the deterministic error digest.

The opt-in model paths in `dep-guard`, `commit-validator`, and `session-recap` also use bounded requests and follow hook cancellation. If a model is unavailable or its answer arrives too late, dependency warnings and commit validation remain deterministic; the session recap still publishes its factual body when the model request fails within the hook deadline.

The host plugin LLM facade now enforces the configured deadline for One Shot, Council and direct-provider compatibility calls even when an injected caller ignores abort. This bounds the time a plugin waits for a result. A provider that ignores cancellation may still continue work internally after its result has been discarded.

The public plugin guide derives optional model review from generated tool parameters, so the evidence analyzers and workflow reviewers appear under the model-aware filter. Source category counts come from the generated catalog.

WebUI Settings can search the full managed catalog by name or summary and filter to effectively enabled plugins. The list still defaults to all plugins, and toggles retain the server-synchronized enablement path. At a 390×300 viewport, the search, filter and first matching switch are reachable without horizontal overflow.

Import microbenchmark samples and scope are recorded in [PERF_LOG.md](../PERF_LOG.md). These numbers measure factory import and instantiation, not whole CLI startup or end-to-end task latency.
