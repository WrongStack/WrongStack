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
| `wstack bench run --suite <id> [flags]` | Run a suite across the model matrix and write a report |
| `wstack bench report <run-dir>` | Re-render `report.md` from a finished run's `summary.json` |

### `run` flags

| Flag | Default | Meaning |
|---|---|---|
| `--suite <local\|polyglot\|swebench>` | `polyglot` | Which suite to run |
| `--models <path>` | `bench.config.json` | Model matrix config (see below) |
| `--limit <N>` | all | Cap the number of tasks (cheap smoke runs) |
| `--concurrency <K>` | from config (4) | Cells run concurrently |
| `--out <dir>` | `bench-results` | Output base directory (a timestamped subdir is created) |
| `--suite-dir <path>` | — | **Required for local unless `--manifest` is set** — directory containing `bench.local.json` |
| `--manifest <path>` | `<suite-dir>/bench.local.json` | Explicit local manifest path |
| `--polyglot-dir <path>` | — | **Required for polyglot** — local checkout of polyglot-benchmark |
| `--languages <a,b>` | all | Restrict polyglot languages (python, javascript, go, rust, cpp, java) |
| `--dataset-dir <path>` | — | **Required for swebench** — materialized instances |
| `--docker` | off | Reserved for inline SWE-bench grading (otherwise predictions are exported) |

## Config (`bench.config.json`)

```json
{
  "maxIterations": 40,
  "concurrency": 4,
  "timeoutMs": 600000,
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
| `report.md` | Leaderboard, sorted by Pass@1, stamped with the fingerprint |
| `summary.json` | Fingerprint + folded per-cell results |
| `results.jsonl` | One row per `(task × cell)`, for reproducibility |
| `predictions-<cell>.jsonl` | (swebench only) official-format predictions for grading |

### Report columns

`Pass@1` (graded tasks only) · `Edit-apply` (% of edit/write tool calls that
applied cleanly — the polyglot edit-accuracy signal) · `$/task` · `tok in/out` ·
`iters (p50)` · `wall (p50)` · `timeout %` · `429s`. Metrics come from the
`--output-json` usage block and the isolated session JSONL (`tool_call_end`,
`provider_retry`/`provider_error`) — never an LLM. Exported-but-ungraded SWE-bench
rows show `—` in Pass@1 so they never masquerade as failures.

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
| `config.ts` | Parse/validate `bench.config.json` |
| `fingerprint.ts` | `computeHarnessFingerprint()` |
| `isolation.ts` | Sandbox: isolated `WRONGSTACK_HOME` + per-cell workdirs (`.meta` excluded) |
| `runner.ts` | Spawn the wstack subprocess, parse `--output-json`, tree-kill on timeout, `mapWithConcurrency` |
| `session-metrics.ts` | Edit-apply % and 429 counts from the session JSONL |
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
