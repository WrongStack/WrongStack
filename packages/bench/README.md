# @wrongstack/bench

Model-independent agentic benchmark harness for WrongStack.

## What it measures

WrongStack is the **harness** — system prompt, tool set, agent loop, scaffolding.
The model is the only swappable variable. Each (task × model) cell runs the real
`wstack` binary in single-shot mode (`--output-json`) inside an isolated workdir;
the result is graded by the **suite's own tests** — never an LLM. This is the
difference from `wstack modeldiag eval`, which ranks free-form answers with an
LLM judge (model-dependent).

Two invariants keep the report objective:

1. **Deterministic grading.** Polyglot runs the exercise's hidden tests;
   SWE-bench runs `FAIL_TO_PASS` / `PASS_TO_PASS`. Exit code decides pass/fail.
2. **Harness fingerprint.** Every report is stamped with a hash of the CLI
   version, tool roster + tool manifest, iteration cap, yolo flag, task subset,
   and any supplied prompt/config hashes. Rows compare only when the fingerprint
   matches; change the prompt/tools/version and old numbers are marked stale.

## Suites

| Suite | Standard | Grader | Status |
|---|---|---|---|
| `local` | Project-defined manifest tasks | command + file assertions in workdir | ✅ Docker-free, graded inline |
| `polyglot` | Aider polyglot (225 Exercism exercises, 6 languages) | run hidden tests in workdir | ✅ Docker-free, graded inline |
| `swebench` | SWE-bench Verified (fixed subset) | export predictions → official harness (inline Docker grading via injectable hook) | ✅ runs + exports; ⚙️ inline grading pluggable |

For SWE-bench the bench runs the agent on each materialized instance and extracts a
conformant model patch (`git diff`, with held-out test files and harness bookkeeping —
`.gitignore` / `.wrongstack/` — stripped), then writes a `predictions-<cell>.jsonl` in the
official format. Grading itself is delegated to the canonical
`princeton-nlp/SWE-bench` harness (deterministic, version-sensitive) rather than
re-implemented — or plugged in inline via a `SwebenchExternalGrade` hook when Docker is
available. Exported-but-ungraded rows show `—` in the report's Pass@1 column so they never
masquerade as failures.

## Requirements

- **API keys in env** — providers read keys from the environment (e.g.
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`). The isolated
  `WRONGSTACK_HOME` carries no secrets.
- **Local:** a `bench.local.json` manifest and one fixture directory per task.
- **Polyglot:** a local checkout of the polyglot-benchmark repo plus the
  language toolchains you want to grade (Python+pytest, Node+npm, Go, Rust,
  …). Languages whose toolchain is missing are simply skipped at grade time.
- **SWE-bench (Phase 2):** Docker + a prepared dataset directory.

## Usage

```bash
# 1. Get the exercises
git clone https://github.com/Aider-AI/polyglot-benchmark /path/to/polyglot

# 2. Define the model matrix (bench.config.json)
cat > bench.config.json <<'JSON'
{
  "maxIterations": 40,
  "concurrency": 4,
  "timeoutMs": 600000,
  "cells": [
    { "label": "opus-4.8", "provider": "anthropic", "model": "claude-opus-4-8" },
    { "label": "gpt-5.4",  "provider": "openai",    "model": "gpt-5.4" }
  ]
}
JSON

# 3. Run (start small with --limit)
wstack bench run --suite polyglot --polyglot-dir /path/to/polyglot \
  --models bench.config.json --limit 5 --out ./bench-results

# 4. Re-render the markdown report from a finished run
wstack bench report ./bench-results/<timestamp>

# List available suites + configured cells
wstack bench list --models bench.config.json
```

## Local manifest suite

Use this for WrongStack-specific regression evals: tool behavior, prompt changes,
permission policy, multi-file edits, or any task that can be graded by a command
and/or simple file checks.

```
evals/
  bench.local.json
  fixtures/
    add-banner/
      README.md
      package.json
      test.mjs
```

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

Run it with:

```bash
wstack bench run --suite local --suite-dir ./evals --models bench.config.json
# or point directly at a manifest
wstack bench run --suite local --manifest ./evals/bench.local.json --models bench.config.json
```

Supported assertions: `file_exists`, `file_not_exists`, `file_contains`,
`file_not_contains`. The local subset fingerprint includes task ids, prompts,
grader/assertion definitions, excludes, and a hash of the copied fixture content.

Artifacts per run (`bench-results/<timestamp>/`):

- `results.jsonl` — one row per (task × cell)
- `summary.json` — fingerprint + folded cell results
- `report.md` — the leaderboard (sorted by pass@1)

## SWE-bench dataset layout

`--dataset-dir <path>` must contain one directory per pinned instance id:

```
<datasetDir>/<instance_id>/
  repo/           git checkout at base_commit
  instance.json   { problem_statement, test_patch, FAIL_TO_PASS, PASS_TO_PASS, image }
```

```bash
# Run the agents and export predictions (no Docker needed):
wstack bench run --suite swebench --dataset-dir ./swe-data --models bench.config.json --limit 5

# Then grade with the official harness:
python -m swebench.harness.run_evaluation \
  --predictions_path ./bench-results/<ts>/predictions-<cell>.jsonl --run_id my-run
```

The pinned subset lives in `subsets/swe-bench-verified-50.json` — replace the
starter list with your chosen N instance ids from the official
`princeton-nlp/SWE-bench_Verified` dataset and never change it afterwards
(changing the subset changes the fingerprint).
