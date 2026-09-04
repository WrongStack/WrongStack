# /brain — The Global Brain (decision support, autonomy ceiling, status)

## What it does

Inspects and steers the session's **Brain** — the decision layer that sits
between the agents and the human. Every autonomous subsystem (Director,
Goal orchestrator, Eternal engine, BrainMonitor) routes its blocking
decisions through one shared Brain instance, bound at
`TOKENS.BrainArbiter`.

```
/brain                  Status: autonomy ceiling + recent decisions
/brain status           Same
/brain stats            Per-tier decision counts — how often a model is actually called
/brain risk <level>     Set the autonomy ceiling: off | low | medium | high | all
/brain ask <question>   Consult the Brain directly for a decision
```

## How the Brain decides — the tier ladder

Cheapest first; each tier only runs when the one above declined.

1. **Rules** (`brain.rules`) — a configured deterministic table, matched on
   source / risk band / fallback / offered options / question+context
   patterns. First match wins; a rule whose action is `defer` explicitly
   hands the request to the next tier. Costs nothing.
2. **Policy** (`DefaultBrainArbiter`) — built-in deterministic behaviour.
   Low-risk requests with a recommended option are answered instantly;
   safe fallbacks (`continue`/`deny`) resolve without any LLM call. The
   pattern heuristics behind it are individually switchable via
   `brain.heuristics` (see `/brain heuristics`).
3. **Cache** (`brain.cache`, off by default) — replays a previous
   council/LLM verdict for an identical repeated question. Deterministic
   tiers are never cached, and a decision the ledger later observes to
   have FAILED is evicted.
4. **Council** (`brain.council`) — a multi-LLM panel for questions at or
   above the council floor. Quorum, veto and weighted majority are
   resolved by pure deterministic maths; only ties reach a judge model.
5. **LLM** (`createAutonomyBrain`) — the single-model tier, within the
   live ceiling. Sees the live provider/model, so `/setmodel` switches
   apply immediately. Guarded by a quality gate (`/brain llm`) and a
   circuit breaker so a dead pool stops costing a full timeout sweep on
   every decision.
6. **Escalation** — in `interactive` mode an actual prompt; in `headless`
   mode the terminal policy (`/brain escalation`) resolves it without a
   human.

`/brain stats` shows how the traffic actually split, which is the number
to watch: every decision resolved above tier 4 is free.

## The autonomy ceiling (`/brain risk`)

| Level | Behaviour |
|-------|-----------|
| `off` | LLM tier disabled — everything the policy can't answer goes to you |
| `low` | LLM auto-decides only low-risk questions |
| `medium` | LLM auto-decides low + medium (default) |
| `high` | LLM auto-decides low + medium + high |
| `all` | LLM auto-decides everything, including critical |

The ceiling is read on **every** decision, so changes take effect
immediately — including for decisions already queued by background
engines.

## Self-activation (BrainMonitor)

The Brain doesn't just wait to be asked. `BrainMonitor` watches the live
EventBus for distress signals and engages the Brain proactively:

- **Tool-failure streak** — the same tool failing 3× consecutively
  (streak resets on success).
- **Error storm** — 4+ `error` events within a 60-second window.

When the Brain decides to intervene, a high-priority `steer` mail is sent
from `brain@<sessionTag>` to this session's leader
(`leader@<sessionTag>`); the mailbox loop injects it into the agent's
next model evaluation before its next step, then removes the raw mail block.
Every engagement — intervening or not —
emits a `brain.intervention` event and is rate-limited by a 120-second
per-signal cooldown.

Without an LLM tier (ceiling `off`, or no provider), the monitor degrades
safely: the policy resolves the `continue` fallback and the Brain observes
without interfering.

## Making the Brain cheaper and more predictable

Every knob below is live-editable and persists to the active profile config.

```
/brain stats                          # where are decisions actually resolved?
/brain rules                          # the deterministic table + compile errors
/brain heuristics                     # the 5 built-in patterns
/brain heuristics deadlock off        # turn one off when its guess is wrong for you
/brain llm                            # quality gate + circuit state
/brain llm uncertain on               # "I don't know" is not an answer
/brain llm confidence 0.6             # reject low-confidence verdicts
/brain llm breaker 3 60000            # skip a dead pool after 3 failures
/brain cache on                       # replay repeated council/LLM verdicts
/brain escalation deny-all            # headless escalations never auto-approve
/brain monitor policy observe         # record signals, never steer (no model call)
```

## Steering the council

The council is the most expensive tier — one provider call *per seat* — so
every knob is reachable from the command line, the TUI `/brain` panel and the
WebUI settings section alike.

```
/brain council                        # is one convened, with which seats and judge?
/brain council personas               # the six built-in decision lenses
/brain council voters a/x:security:veto b/y:maintainer c/z:auditor
/brain council judge anthropic/claude-opus-5
/brain council distinctness provider  # report a panel that is not actually diverse
/brain council quorum 0.75            # how many seats must return a valid vote
/brain council approval 0.6           # winner must exceed this share, else the judge decides
/brain council timeout 20000          # per-seat budget
/brain council concurrency 6          # seats polled at once, 1..8
/brain council judgetokens 700        # output budget for the tie-breaker
/brain council rounds 1               # turn deliberation off (default 2)
```

### Deliberation rounds

By default a panel votes **twice**. Round 1 is independent — no seat sees any
other. In round 2 every seat is shown the other seats' ballots, including its
own, and votes again; only the final round is tallied. A seat that missed a
consequence another lens caught can revise on it.

The cost is linear and unconditional: two rounds means **two provider calls per
seat on every council decision**, not only contested ones. `/brain council
rounds 1` restores the single-round panel.

The trade is independence for information, and it is not free — models converge
on a stated majority whether or not the majority brought an argument. Three
things push back on that:

- The voter instruction says so explicitly: change your vote only on substance
  you had not accounted for, *agreement is not evidence*, and holding your
  position is a full answer.
- Other seats' ballots arrive as delimited **untrusted quoted data**, so an
  instruction smuggled into a rationale carries no more authority than one
  smuggled into the question.
- `deliberationChanges` on the resolution reports how many seats actually
  moved. Watch it: `0` every time means the second round is buying cost and
  nothing else, and a figure near the seat count means the panel is conforming
  rather than reasoning. The orchestrator warns when a majority of the panel
  moves in one round, and separately when a **veto seat** folds — a veto that
  can be talked out of its veto is not a safety property.

Two things worth setting deliberately:

- **`distinctness`** — default `none`, which means a panel whose seats all
  resolve to the same model produces a perfectly normal-looking unanimous
  verdict while adding cost without adding independence. `provider` reports it.
- **`judge`** — left on `auto` the judge is derived from the pool, and when the
  pool has no model left over after seating it becomes one of the voters. Both
  the TUI panel and the WebUI flag that case (`⚠ also a voter`), but pinning the
  judge avoids it.

Council votes now surface live: the TUI shows seat progress while the panel
votes and attaches the full ballot to the decision card, and the WebUI posts the
panel summary with any distinctness warning.

The highest-leverage change is usually a `brain.rules` entry, not a model
swap: a rule resolves the question before any tier that costs tokens. See
[configuration.md](../configuration.md#brain--decision-layer-autonomy-rules-council-trace).

## Replay trace

```
/brain trace on                       # record how each decision was made
/brain trace content redacted         # keep the shape, drop the free text
```

One JSONL row per decision in `<project>/.wrongstack/brain-trace.jsonl`:
every tier the ladder ran, every pool target called (**including the
failures the fallback loop otherwise swallows**), every council seat's
vote, timings and token totals. Rows convert to replayable fixtures via
`brainTraceToEvaluationCase()` and run offline through
`runBrainEvaluation()`, which never dispatches the decisions it replays.

Disabled by default — enabling it is the opt-in that permits production
decision content on disk. `content: none` still records models, timings,
tokens and vote ids.

## Examples

```
/brain
/brain risk high
/brain ask should we keep retrying the flaky integration test or skip it?
```

## Events

| Event | When |
|-------|------|
| `brain.decision_answered` | Brain answered (carries `tier`) |
| `brain.decision_ask_human` | Brain escalated to the human |
| `brain.decision_denied` | Brain denied the request |
| `brain.intervention` | BrainMonitor engaged (with `intervened: true/false`) |
| `brain.outcome` | An earlier decision's real-world result became observable |
| `brain.tier_transition` | One step of the ladder: tier, outcome, whether it was terminal |
| `brain.llm_call` | One attempt against one pool target — model, timing, tokens, failures |
| `brain.council_vote` | One council seat's observable vote |
| `brain.council_resolved` | Quorum/veto/majority resolution + judge usage |

`brain.decision_*` carries a `tier` field (`rule`, `policy`, `heuristic`,
`cache`, `ledger-guard`, `council`, `llm`, `terminal`, `human`) so surfaces
can distinguish a free decision from one that cost a provider call —
that is what `/brain stats` counts.

`/brain status` shows the last 20 decisions for the session.

## WebUI

`/brain` works in the WebUI chat too (same subcommands), implemented over
WebSocket messages (`brain.status` / `brain.risk` / `brain.ask`). The
standalone WebUI server runs its own Brain instance — policy → LLM only;
without a human-escalation prompt, `ask_human` decisions surface as
`brain.event` messages and the caller's fallback applies.

## Related

- `/autonomy` — the eternal engine consults the Brain instead of
  auto-stopping on brainstorm-DONE / failure-budget thresholds.
- `/mailbox` — where Brain steer messages land.
- `docs/slash/goal.md` — phase orchestrator Brain consultations.
