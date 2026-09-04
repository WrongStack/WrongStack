# `wstack bench` — Model-Independent Agentic Benchmarks

## What it does

Runs reproducible, **model-independent** agentic benchmarks against the WrongStack
harness and produces a leaderboard report. It holds the harness fixed (system
prompt + tool set + agent loop + scaffolding) and swaps **only the model** between
rows, then grades the result with the suite's **own tests** — never an LLM judge.

This is the deterministic counterpart to `wstack modeldiag eval`, which ranks
free-form answers with an LLM (model-*dependent*). Implemented in
[`@wrongstack/bench`](../../packages/bench/README.md).

| Suite | Standard | What it measures | Grading |
|---|---|---|---|
| `core` | Bundled 6-task Node agent-edit eval (ships with the package) | edit accuracy under tests | Node tests + sentinel so tests cannot be gutted |
| `smoke` | 3 trivial file edits | harness wiring | command + file assertions — not a quality score |
| `local` | Project-defined manifest tasks | WrongStack-specific regressions | run manifest command and/or file assertions in the workdir |
| `polyglot` | [Aider polyglot](https://github.com/Aider-AI/polyglot-benchmark) (225 Exercism exercises, 6 languages) | edit accuracy | run the exercise's hidden tests in the workdir (exit code) |
| `swebench` | [SWE-bench Verified](https://www.swebench.com/) (fixed subset) | end-to-end issue resolution | export conformant predictions → official harness (or inline Docker hook) |

## Two invariants that keep reports comparable

1. **Deterministic grading.** Pass/fail comes from the suite's own test suite, not
   a model. Polyglot runs the hidden tests; SWE-bench runs `FAIL_TO_PASS` /
   `PASS_TO_PASS` via the official harness.
2. **Harness fingerprint.** Every report is stamped with a hash of the CLI
   version, tool roster + tool manifest, iteration cap, yolo flag, task subset,
   and any supplied prompt/config hashes. Rows are only comparable across
   reports that share a fingerprint; changing the prompt, tool descriptions or
   schemas, the iteration cap, or the task subset flips the hash and marks
   older numbers stale.

## How model-independence works

Each `(task × model)` cell runs the **real `wstack` binary** as a subprocess in an
isolated working directory:

```
wstack --prompt "<task>" --provider <p> --model <m> \
       --output-json --no-tui --no-interactive --no-banner \
       --yolo --no-models-refresh --skip-index
  cwd: <isolated task workdir>
  env: WRONGSTACK_HOME=<isolated home>   (provider keys inherited from the parent env)
```

Because the subprocess is the *whole* harness (real wiring, real tools), the only
variable between cells is `--provider`/`--model`. Process isolation also makes the
run robust to a model crashing, hanging (per-task timeout + tree-kill), or OOMing.

## Commands

| Usage | Effect |
|---|---|
| `wstack bench` | Print usage |
| `wstack bench list [--models <config>]` | Show suites; with `--models`, list configured cells + the harness header |
| `wstack bench mine --transcript <session.jsonl> [--out <eval-dir>]` | Copy a real transcript into the corpus and emit curator-ready trace-eval drafts |
| `wstack bench run [--suite <id>] [--cell spec] [flags]` | Run a suite across the model matrix and write a report |
| `wstack bench compare <baseline> <candidate>` | Diff two finished run directories (fingerprint-aware) |
| `wstack bench report <run-dir>` | Re-render `report.md` from a finished run's `summary.json` + `results.jsonl` |

Instant path (no config file, no dataset clone):

```bash
wstack bench run --cell anthropic/claude-sonnet-4-6,openai/gpt-5.4
wstack bench compare ./bench-results/<baseline> ./bench-results/<candidate>
```

`--cell` is `provider/model` or `label=provider/model`, comma-separated. If omitted,
`bench.config.json` is used when present, otherwise the saved `wstack` provider/model.

### `run` flags

| Flag | Default | Meaning |
|---|---|---|
| `--suite <core\|smoke\|local\|polyglot\|swebench>` | `core` | Which suite to run |
| `--cell <spec>` | — | Comma-separated model cells; skips the config file |
| `--models <path>` | `bench.config.json` | Model matrix config (optional when `--cell` or a saved model is set) |
| `--limit <N>` | all | Cap the number of tasks (cheap smoke runs) |
| `--concurrency <K>` | from config (4; smoke default 2) | Cells run concurrently |
| `--out <dir>` | `bench-results` | Output base directory (a timestamped subdir is created) |
| `--suite-dir <path>` | — | **Required for local unless `--manifest` is set** — directory containing `bench.local.json` |
| `--manifest <path>` | `<suite-dir>/bench.local.json` | Explicit local manifest path |
| `--polyglot-dir <path>` | — | **Required for polyglot** — local checkout of polyglot-benchmark |
| `--languages <a,b>` | all | Restrict polyglot languages (python, javascript, go, rust, cpp, java) |
| `--dataset-dir <path>` | — | **Required for swebench** — materialized instances |
| `--docker` | off | Reserved for inline SWE-bench grading (otherwise predictions are exported) |
| `--repeats <N>` | `1` | Attempts per `(task × model)`. `>1` unlocks Pass@k, All-pass and a flakiness count |
| `--keep-sandbox` | off | Keep the temporary sandbox (workdirs + isolated home) on disk for debugging |

## Config (`bench.config.json`)

```json
{
  "maxIterations": 40,
  "concurrency": 4,
  "timeoutMs": 600000,
  "repeats": 1,
  "cells": [
    { "label": "opus-4.8", "provider": "anthropic", "model": "claude-opus-4-8" },
    { "label": "gpt-5.4",  "provider": "openai",    "model": "gpt-5.4" }
  ]
}
```

`cells` is required and labels must be unique (default label `provider/model`). The
other fields default as shown. Provider API keys are read from the environment
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) — the isolated home
carries no secrets.

## Output artifacts (`<out>/<timestamp>/`)

| File | Contents |
|---|---|
| `report.md` | Leaderboard (Pass@1), cost-vs-quality, per-task matrix, intra-run disagreements |
| `summary.json` | Fingerprint + folded per-cell results |
| `results.jsonl` | One row per `(task × cell × attempt)`, for reproducibility. Written **incrementally** as rows land, so an interrupted run keeps what it finished |
| `compare.md` | Written by `wstack bench compare` into the candidate directory |
| `predictions-<cell>.jsonl` | (swebench only) official-format predictions for grading |

`wstack bench compare <baseline> <candidate>` checks harness fingerprints first.
Matching hashes mean the deltas are model/run variance. A mismatch still prints
numbers but labels the report **Not comparable** and lists what changed (CLI
version, subset, tool manifest, prompt hash, …). Shared `(task × model)` cells
that flipped pass/fail are listed explicitly.

### Report columns

`Pass@1` (graded attempts only) · `Edit-apply` (% of edit/write tool calls that
applied cleanly — the polyglot edit-accuracy signal) · `$/task` · `tok in/out` ·
`iters (p50)` · `wall (p50)` · `timeout %` · `429s`.

With `--repeats N` the leaderboard swaps in three more columns: `Pass@N` (tasks
solved at least once), `All-pass` (tasks solved on every attempt) and
`Flaky tasks` (tasks whose own attempts disagreed). A large flaky count is the
signal that a gap between two models is noise rather than a result.

A `## Failures` section lists every failing `(task × model)` row with its run
status and the grader's own detail (failing tests, compiler error) or the
agent's reported error — so a red row is diagnosable without opening
`results.jsonl`. When any attempt timed out or crashed before printing its usage
payload, the report says so explicitly: those rows contribute zero tokens and
zero cost, making the `$/task` and token columns lower bounds. Metrics come from the
`--output-json` usage block and the isolated session JSONL (`tool_call_end`,
`provider_retry`/`provider_error`) — never an LLM. Exported-but-ungraded SWE-bench
rows show `—` in Pass@1 so they never masquerade as failures.

When a local manifest contains transcript-mined `traceEval` cases, the report adds
three causal columns: **Retrieval**, **Recall (given retrieval)**, and **Edit
application (given recall)**. The last column follows the same correct-intent
tool-use id to `tool_call_end.ok`, so a model that emits the right edit but whose
tool invocation fails is counted as a tooling/application failure, not as a model
or retrieval failure.

## Core (default)

Six Node-only agent-edit tasks ship inside `@wrongstack/bench`. Each is graded
by `node test.mjs` plus a sentinel assertion so gutted tests cannot pass.
This is what `wstack bench run` executes when `--suite` is omitted.

| Task | What it measures |
|---|---|
| `merge-intervals` | implement a spec; overlapping/touching/unsorted edge cases |
| `broken-pager` | find and fix an off-by-one in existing code |
| `cross-file-rename` | rename a symbol across multiple files |
| `frozen-contract` | change behavior without editing a frozen public file |
| `query-parser` | parse a small language (encoding, repeats, typed `limit`) |
| `rate-limiter` | stateful class with an injectable clock |

`--suite smoke` is the 3-task wiring check (`add-banner` / `rename-export` /
`strip-todo`). Do not rank models on it.

```bash
wstack bench run --cell opus=anthropic/claude-opus-4-8,haiku=anthropic/claude-haiku-4-5
```

## Polyglot

```bash
git clone https://github.com/Aider-AI/polyglot-benchmark /path/to/polyglot
wstack bench run --suite polyglot --polyglot-dir /path/to/polyglot \
  --models bench.config.json --limit 5
```

Requires the language toolchains you want to grade (Python+pytest, Node+npm, Go,
Rust, …). The `.meta/` reference solution is never copied into the agent's workdir.

## Local

Local evals are project-owned regression tests. A manifest describes the prompt,
fixture directory, and deterministic grader signals:

```json
{
  "tasks": [
    {
      "id": "add-banner",
      "prompt": "Update README.md so it starts with the product banner. Do not modify package.json.",
      "templateDir": "./fixtures/add-banner",
      "grader": {
        "type": "command",
        "command": "node",
        "args": ["test.mjs"],
        "shell": false
      },
      "assertions": [
        { "type": "file_contains", "path": "README.md", "text": "# WrongStack" },
        { "type": "file_not_contains", "path": "README.md", "text": "TODO" }
      ]
    }
  ]
}
```

```bash
wstack bench run --suite local --suite-dir ./evals --models bench.config.json
wstack bench run --suite local --manifest ./evals/bench.local.json --models bench.config.json
```

Supported assertions: `file_exists`, `file_not_exists`, `file_contains`,
`file_not_contains`. The local subset fingerprint includes task ids, prompts,
grader/assertion definitions, excludes, and a hash of fixture content.

### Transcript-mined diagnostic cases

Use `traceEval` for the retrieval/recall/tooling diagnostic corpus. Every such
case must carry an immutable provenance record for a real, copied session JSONL:
the original session id, a source transcript path, its SHA-256, and the inclusive
event range from which the case was curated. The loader verifies the hash, event
range, and session id before a run; a hand-written synthetic substitute cannot
silently enter this corpus.

```json
{
  "id": "handler-replacement-from-session",
  "prompt": "Modernize the handler implementation.",
  "templateDir": "./fixtures/handler-replacement",
  "assertions": [{ "type": "file_contains", "path": "src/handler.ts", "text": "modern handler" }],
  "traceEval": {
    "source": {
      "sessionId": "sess_01J...",
      "transcriptPath": "./corpus/sess_01J.jsonl",
      "sha256": "<64-character sha256>",
      "eventStart": 12,
      "eventEnd": 29
    },
    "retrieval": [{ "toolNames": ["read", "grep"], "contains": "legacy handler" }],
    "recall": {
      "toolNames": ["edit", "write", "apply_patch"],
      "inputContains": ["src/handler.ts", "modern handler"]
    }
  }
}
```

The fixture is the frozen pre-edit worktree captured with that session; retain it
next to the provenance JSONL. Metric denominators are deliberately conditional:
retrieval is over all trace cases, recall only over cases where the required
evidence was retrieved, and edit application only over cases where the model
emitted the expected intent. That makes “retrieval, model, or tooling?” a direct
read from the report instead of an inference from Pass@1.

Start this workflow with a real session, rather than hand-authoring a trace:

```bash
wstack bench mine \
  --transcript ~/.wrongstack/projects/<project>/sessions/<date>/sess_<id>.jsonl \
  --out ./evals
```

This copies the original JSONL verbatim to `./evals/corpus/` and writes
`./evals/trace-eval-drafts.json`: one candidate per edit attempt, seeded with
the latest user prompt, a preceding retrieval marker, correct-intent input
markers, and whether that exact invocation applied. The draft is intentionally
not a runnable task until a curator freezes the pre-edit worktree and adds a
deterministic grader; this avoids manufacturing a synthetic test from partial
transcript data.

## SWE-bench

`--dataset-dir <path>` must contain one directory per pinned instance id:

```
<datasetDir>/<instance_id>/
  repo/           git checkout at base_commit
  instance.json   { problem_statement, test_patch, FAIL_TO_PASS, PASS_TO_PASS, image }
```

The bench runs the agent on each instance and extracts a conformant model patch
(`git diff`, with held-out test files and harness bookkeeping — `.gitignore`,
`.wrongstack/` — stripped), writing `predictions-<cell>.jsonl`. Grading is delegated
to the canonical, version-sensitive harness rather than re-implemented:

```bash
wstack bench run --suite swebench --dataset-dir ./swe-data --models bench.config.json --limit 5
python -m swebench.harness.run_evaluation \
  --predictions_path ./bench-results/<ts>/predictions-<cell>.jsonl --run_id my-run
```

Inline Docker grading can be plugged in via the `SwebenchExternalGrade` hook in
`@wrongstack/bench`. The fixed subset lives in
`packages/bench/subsets/swe-bench-verified-50.json` — pin your chosen N instance ids
from the official `princeton-nlp/SWE-bench_Verified` dataset **once** and never
change it (changing the subset changes the fingerprint).

## Architecture

`@wrongstack/bench` depends only on `@wrongstack/core` (dependency direction
`bench → core`). Key modules:

| Module | Responsibility |
|---|---|
| `config.ts` | Parse/validate `bench.config.json` and `--cell` specs |
| `suites/core.ts` | Bundled 6-task agent-edit eval (default `bench run`) |
| `suites/smoke.ts` | Bundled 3-task wiring check |
| `compare.ts` | Intra-run matrix + baseline-vs-candidate diffs |
| `fingerprint.ts` | `computeHarnessFingerprint()` |
| `isolation.ts` | Sandbox: isolated `WRONGSTACK_HOME` + per-cell workdirs (`.meta` excluded) |
| `runner.ts` | Spawn the wstack subprocess, parse `--output-json`, tree-kill on timeout, `mapWithConcurrency` |
| `session-metrics.ts` | Edit-apply % and 429 counts from the session JSONL |
| `trace-eval.ts` | Deterministic retrieval → recall → edit-application funnel for transcript-mined cases |
| `suites/local-manifest.ts`, `graders/local-manifest-grader.ts` | Local manifest loader + deterministic command/file grader |
| `suites/polyglot.ts`, `graders/polyglot-grader.ts` | Polyglot loader + deterministic grader |
| `suites/swebench.ts`, `suites/swebench-patch.ts`, `graders/swebench-grader.ts` | SWE-bench loader, patch extraction, grader |
| `report/predictions.ts` | Official-format predictions export + resolved-id parsing |
| `aggregate.ts`, `report/markdown.ts`, `report/json.ts` | Fold results → report artifacts |
| `orchestrate.ts` | `runBenchmark()` — fan out `(task × cell)`, grade, fold |

## Testing

`pnpm --filter @wrongstack/bench test` (or `pnpm vitest run packages/bench/tests`).
Tests cover fingerprint determinism, config validation, aggregate math (including
graded-vs-ungraded), the polyglot grader against a fixture exercise, patch
extraction against a real temp git repo, predictions round-trip, and the full
orchestration via a fake `wstack` script — **no real API calls**.
