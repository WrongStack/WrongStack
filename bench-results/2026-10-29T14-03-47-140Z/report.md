# WrongStack benchmark — polyglot

**Harness:** wrongstack@1.3.0 · fp:e5513df3ac47 · maxIter=40 · yolo · profile=lean
**Finished:** 2026-10-29T14:48:46.444Z
**Tasks/cell:** 40
**Attempts/task:** 3 (pass@1 is measured over every attempt)

Grading is deterministic (the suite's own tests decide pass/fail — no LLM judge). The only variable across rows is the model; everything else is fixed by the harness fingerprint.

| Model | Pass@1 | Pass@3 | All-pass | Flaky tasks | Edit-apply | $/task | tok/task | tok/solve | iters (p50) | wall (p50) | timeout | 429s | subagents |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| deepseek-v4.1-flash | 100.0% | 100.0% | 100.0% | 0/40 | 98.9% | $0.004 | 67.2k | 67.2k | 6 | 45.4s | 0.0% | 0 | 0 |

_Pass@1 is the share of all 3 attempts that passed; Pass@3 is the share of tasks solved at least once; All-pass is the share solved every time. Flaky tasks split their own attempts — a large flaky count means the gap between two models may be noise.

_tok/task is every token an attempt moved — full prompt including cache reads plus output, leader and subagents/companions together. tok/solve is all tokens spent divided by passing attempts: the price of one solved task, failures included. Lower is better._

_Subagents is a cell-wide TOTAL of delegation starts (`delegate_started` events plus `spawn_subagent` tool calls) summed over every task and attempt — not a per-task average._

_Fingerprint hash: `e5513df3ac47` · tools: 6 · subset: `polyglot:7adc0f98d56c`_

## Cost vs quality

| Model | Pass@1 | $/task | Pass per $ | tok/solve |
|---|---:|---:|---:|---:|
| deepseek-v4.1-flash | 100.0% | $0.004 | 240.7 | 67.2k |

_Pass per $ is Pass@1 / average USD per task. Higher is better. Zero-cost rows show —._

## Per-task matrix

| Task | deepseek-v4.1-flash |
|---|---|
| polyglot/python/connect | PASS |
| polyglot/python/dominoes | PASS |
| polyglot/python/food-chain | PASS |
| polyglot/python/grep | PASS |
| polyglot/python/hangman | PASS |
| polyglot/python/paasio | PASS |
| polyglot/python/pov | PASS |
| polyglot/python/react | PASS |
| polyglot/python/transpose | PASS |
| polyglot/python/tree-building | PASS |
| polyglot/javascript/alphametics | PASS |
| polyglot/javascript/bowling | PASS |
| polyglot/javascript/food-chain | PASS |
| polyglot/javascript/grade-school | PASS |
| polyglot/javascript/palindrome-products | PASS |
| polyglot/javascript/resistor-color-trio | PASS |
| polyglot/javascript/robot-name | PASS |
| polyglot/javascript/tournament | PASS |
| polyglot/javascript/twelve-days | PASS |
| polyglot/javascript/two-bucket | PASS |
| polyglot/go/alphametics | PASS |
| polyglot/go/beer-song | PASS |
| polyglot/go/bowling | PASS |
| polyglot/go/counter | PASS |
| polyglot/go/palindrome-products | PASS |
| polyglot/go/react | PASS |
| polyglot/go/robot-simulator | PASS |
| polyglot/go/say | PASS |
| polyglot/go/tree-building | PASS |
| polyglot/go/trinary | PASS |
| polyglot/rust/accumulate | PASS |
| polyglot/rust/bowling | PASS |
| polyglot/rust/decimal | PASS |
| polyglot/rust/doubly-linked-list | PASS |
| polyglot/rust/fizzy | PASS |
| polyglot/rust/nucleotide-codons | PASS |
| polyglot/rust/ocr-numbers | PASS |
| polyglot/rust/parallel-letter-frequency | PASS |
| polyglot/rust/pig-latin | PASS |
| polyglot/rust/react | PASS |
