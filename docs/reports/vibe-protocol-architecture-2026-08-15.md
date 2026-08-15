# [VIBE] Protocol — Architecture, Defects, and Fix Evidence

Date: 2026-08-15  
Scope: prompt-entry path from composer to agent final response.

## 1. What `[VIBE]` is

`[VIBE]` is a case-insensitive **control tag** in the user prompt (`[VIBE]`, `[vibe]`, `[vIbE]`). It is not a slash command and not an attachment. When present, the host is supposed to lock that turn into the Three-Stage Verification Protocol:

1. **Spec-Synthesizer** — turn the raw prompt into a structured spec.
2. **Coder** — inject a contract so the model implements the spec, not the raw vibe.
3. **Auditor** — inspect the first final text response and append a durable report.

Detection is substring-anywhere: start, middle, or end of the prompt.

## 2. Runtime architecture

```text
 Composer (TUI / WebUI / SimpleUI / CLI)
   │  user types "... [VIBE] ..."
   │
   ├─ UI only (no protocol execution)
   │    TUI: [VIBE] rendered as an input chip (backspace deletes the whole tag)
   │    SimpleUI / WebUI intake: 🌊 pill ("protocol is active")
   │    Prompt enhancer (TUI): preserve/restore [VIBE] if the refiner drops it
   │    /intake: persist isVibeMode + vibeProtocol on the intake record
   │
   └─ Agent.run(text)
        pipelines.userInput
          VibeProtocolInput
            hasVibeTag(text)?
              no  → pass through
              yes → synthesizeVibeSpec
                    buildCoderContract
                    append [vibe_protocol] block to payload.text + content
                    ctx.meta.vibeProtocol = { stage: 'coder', spec, coder }
        Agent loop (tools allowed; auditor waits)
        pipelines.response
          VibeProtocolAuditor
            skip while tool_use is present
            else auditVibeExecution(coder text)
            append markdown report
            ctx.meta.vibeProtocol = { stage: passed|auditor, audit }
```

### Layers and ownership

| Layer | Package | Role |
| --- | --- | --- |
| Tag parse + intake persistence | `@wrongstack/requirement-intake` | `hasVibeTag`, `stripVibeTag`, `deriveVibeState` |
| Spec / contract / audit engine | `@wrongstack/sdd` | `synthesizeVibeSpec`, `buildCoderContract`, `auditVibeExecution`, `formatVibeReport` |
| Agent pipeline install | `@wrongstack/sdd` `installVibeProtocol` | userInput + response middleware |
| CLI / TUI / `wstack --webui` | `@wrongstack/cli` lifecycle-plugins | calls `installVibeProtocol` |
| Standalone WebUI server | `@wrongstack/webui-server` `createAgentServices` | same install (after this fix) |
| Surfaces | TUI / SimpleUI / WebUI intake | chip / pill only |

Intake and the live agent are **two tracks that share the tag, not the pipeline**. `/intake` stores `isVibeMode` and leaves `stage` at `synthesizer`. It does not run synthesizer → coder → auditor. The agent run does the opposite: it executes the three stages and does not write an intake record.

### Prompt-entry surfaces

| Surface | Sees the tag? | Runs the protocol? |
| --- | --- | --- |
| TUI composer | Yes — chip + enhancer preserve | Yes — CLI lifecycle |
| CLI / single-shot / `wstack --webui` / SimpleUI via CLI | Yes if present in submitted text | Yes — same CLI agent |
| WebUI Requirement Intake form | Yes — 🌊 pill | No — only flags the record |
| Standalone `webui-server` chat | Pill only on intake; chat used to skip install | Yes after this fix |
| Fleet / ACP subagents | Not installed (own empty pipelines) | No — by design; they are workers, not the user turn |

### Why next-steps `[VIBE]` does not retrigger

`VibeProtocolInput` reads **this turn's user text only**. An assistant `<nextsteps>` block that mentions `[VIBE]` never goes through `userInput`. The auditor also only runs when `active` was set by a tagged user turn. This is covered by wiring + e2e tests.

## 3. Defects found (with proof)

### D1. `stripVibeTag` removed only the first tag

`VIBE_TAG_REGEX` was `/\[VIBE\]/i` (no `g`). `String.replace` therefore stripped one occurrence.

Proof (pre-fix semantics):

```text
stripVibeTag('[VIBE] önce [vibe] sonra [VIBE]')
  → 'önce [vibe] sonra [VIBE]'   // leftover tags leaked into the synthesized spec
```

Synthesizer calls `stripVibeTag` before deriving core intent. A leftover tag pollutes the spec.

### D2. Auditor false-positive on echoed policy phrases

Default exclusions are English policy sentences:

- `Unrelated UI refactors`
- `Unrequested third-party dependency additions`

Those strings are injected into the coder prompt. If the model repeats them ("I did not introduce Unrelated UI refactors"), `auditVibeExecution` treated that as scope bleed and **REJECT**ed.

Proof (pre-fix): any coder output containing those phrases failed `scope-bleed` even when the implementation was in-scope. Identifier exclusions such as `unwanted-library` are the only substring checks that make sense.

### D3. Auditor claimed it executed acceptance criteria

`formatVibeReport` marked every criterion `[x]`. The acceptance check passed whenever coder text was non-empty. That is a rubber stamp, not verification.

### D4. TUI treated `[VIBE]` as an attachment chip

`INLINE_TOKEN_SRC` included `\[VIBE\]`. On submit, `refineSubmittedPrompt` stripped every chip before `enhanceUserPrompt`, then appended chips as a **suffix**.

Effects:

- The refiner never saw `[VIBE]` (so `preserveVibeTag` in the enhancer was dead on the TUI path).
- A refined send became `refined text [VIBE]` instead of keeping the tag in place.
- Attachment expand/preview grammar was mixed with a protocol tag.

Rendering/backspace-as-a-chip is useful. Stripping it as an attachment is not.

### D5. Standalone WebUI advertised VIBE but did not install it

`installVibeProtocol` claimed "CLI, TUI, WebUI, and single-shot". Only `setupLifecycleAndPlugins` (CLI) actually installed it. `createAgentServices` in `@wrongstack/webui-server` created fresh pipelines and installed Design Studio, not VIBE.

`wstack --webui` happened to work because it reuses the CLI agent. Standalone WebUI chat did not. The intake 🌊 pill still told the user the protocol was active.

## 4. Fixes applied

| ID | Change |
| --- | --- |
| D1 | `stripVibeTag` now uses `/\[VIBE\]/gi`. `VIBE_TAG_REGEX` stays non-global so `RegExp#test` cannot skip via `lastIndex`. |
| D2 | `isIdentifierLikeExclusion` — only identifiers / quoted tokens are substring-matched. Policy sentences are ignored. |
| D3 | Report uses `[ ]` and states the auditor did not independently execute the criteria. Check details say the same. |
| D4 | Split `ATTACHMENT_TOKEN_SRC` vs `PROTOCOL_TOKEN_SRC`. Refiner chip-strip uses attachments only. `[VIBE]` still renders/deletes as a chip. |
| D5 | `installVibeProtocol` lives in `@wrongstack/sdd`. CLI re-exports it. `createAgentServices` installs it on standalone WebUI pipelines. |

## 5. After-fix evidence

Command:

```text
pnpm exec vitest run
  packages/requirement-intake/tests/vibe.test.ts
  packages/sdd/tests/vibe-protocol.test.ts
  packages/sdd/tests/vibe-protocol-wiring.test.ts
  packages/cli/tests/vibe-protocol-wiring.test.ts
  packages/cli/tests/vibe-agent-e2e.test.ts
  packages/tui/tests/input-tokens.test.ts
  packages/tui/tests/submit-prompt-refinement.test.ts
  packages/webui-server/tests/backend-services.test.ts
  packages/core/tests/execution/prompt-enhancer.test.ts
```

Result: **9 files, 105 tests, all passed** (2026-08-15).

New / updated assertions:

- `stripVibeTag('[VIBE] önce [vibe] sonra [VIBE]') === 'önce sonra'`
- Echo of `Unrelated UI refactors` → audit `PASS`, no `scope-bleed`
- `unwanted-library` import still `REJECT`s
- TUI `ATTACHMENT_TOKEN_SRC` does not match `[VIBE]`; `splitChips` still chips it
- Refiner `complete()` request body contains `[VIBE]`
- `createAgentServices` registers `VibeProtocolInput` + `VibeProtocolAuditor`
- Existing Agent.run e2e still: synthesizer → tool loop → auditor PASS, and a later next-steps `[VIBE]` does not retrigger

## 6. Remaining (not bugs of the tag path)

- The auditor is still **deterministic and shallow**: non-empty final text that does not mention an identifier-like exclusion still PASSes. It is a contract receipt, not a test runner. The report now says so.
- `active` is one in-flight VIBE run per pipelines instance. One agent cannot `run()` concurrently (guarded). Two agents sharing one pipelines object would still race.
- Requirement-intake `deriveVibeState` keeps vibe mode across later edits even if the tag is omitted. That is intake-record persistence, not agent-turn persistence.
- ACP / fleet subagent pipelines do not install VIBE. They should not; they are not the user composer.
