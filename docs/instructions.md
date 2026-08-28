# Instruction Overrides

WrongStack's durable system instructions are file-backed and layered:

1. Bundled defaults: `packages/core/instructions/`
2. Active-profile overrides: `~/.wrongstack/profiles/<name>/instructions/`
3. Project overrides: `<project>/.wrongstack/instructions/`
4. Explicit `DefaultSystemPromptBuilder` `instructionPaths.files`
5. In-memory `instructionBundle` overrides

Later layers override earlier layers field-by-field.

## Supported Files

Use Markdown for the common system prompt sections:

- `system.md` — replaces the default baseline system identity/instructions block.
- `system-pro.md` — replaces the pro baseline system identity/instructions block when `systemPrompt.variant` is `"pro"` or the launch uses `--system-pro` / `--system-prompt pro`.
- `system-lite.md` — replaces the compact baseline system identity/instructions block when `systemPrompt.variant` is `"lite"`.
- `leader-after-task.md` — replaces the host-only after-task guidance block.
- `sections/**/*.md` — replaces named reusable prompt sections.
- `agents/<agent-id>.md` — bundled subagent role prompts used by the fleet catalog.
- `modes/<mode-id>.md` — built-in mode prompt bodies.
- `llm/*.md` — internal helper LLM system prompts.
- `coordination/*.md` — Director and subagent baseline prompt blocks.
- `autonomy/*.md` — long-running autonomy loop prompt templates.
- `goal/*.md` — autonomous phase-planning templates.
- `sdd/*.md` — SDD helper prompt templates.
- `security-scanner/*.md` — security scanner LLM prompt templates.
- `cli/*.md` — CLI helper LLM prompt templates.

Nested section file names become dot-separated keys. Hyphens also become dots:

- `sections/tool/delegation-compact.md` -> `tool.delegation.compact`
- `sections/tool/mcp-full-use.md` -> `tool.mcp.full.use`

Use JSON when a structured override is easier:

```json
{
  "version": 1,
  "system": {
    "identity": "You are WrongStack...",
    "leaderAfterTask": "## After-task suggestions..."
  },
  "sections": {
    "future-section": "Reserved for additional prompt sections."
  }
}
```

If both `instructions.json` and Markdown files exist in the same directory, the
Markdown files win for their matching fields.

## Selecting `system-pro.md`

Use the pro baseline for one launch:

```bash
wstack --system-pro
# or
wstack --system-prompt pro
```

Or make it the default in config:

```jsonc
{
  "systemPrompt": {
    "variant": "pro"
  }
}
```

To override the pro prompt for one project without committing it, create:

```text
<project>/.wrongstack/instructions/system-pro.md
```

The same layering rules apply: profile and project `system-pro.md` files override
the bundled `packages/core/instructions/system-pro.md` only when the selected
variant is `pro`; default launches continue to read `system.md`.

## Conditional Blocks

The system identity files (`system.md`, `system-lite.md`, `system-pro.md`), the
`leader-after-task.md` layer, and every file under `sections/` are rendered
against the live request before they reach the prompt. Text about a tool the
request has not registered is dropped rather than shipped — at `minimal` tier
that removes roughly 40 % of the default identity prompt, and it stops the model
being told about tools it cannot call.

Blocks are delimited by HTML comments, so a markdown preview stays clean:

```markdown
<!--ws:if tool=kanban-->
## Work planning with Kanban
Track multi-step work on the board.
<!--ws:else-->
Track multi-step work with `todo`.
<!--ws:end-->
```

A condition is a set of space-separated attributes. Attributes are ANDed;
comma-separated values within one attribute are ORed; a leading `!` negates.

| Attribute | True when |
|---|---|
| `tool=a,b,c` | at least one of those tools is registered for this request |
| `!tool=a,b` | none of those tools is registered |
| `tier=off,medium` | the active `features.tokenSavingMode` tier is one of these |
| `role=leader` / `role=subagent` | the prompt is being built for that role |

`<!--ws:if tool=kanban tier=off-->` therefore means "kanban is registered **and**
no token saving is active". Blocks nest, which is also how you AND two `tool`
sets: put one `ws:if` inside the other.

For tool inventory lines, `{{tools:...}}` renders only the registered names,
backticked and comma-joined — and renders as nothing when none of them are
present:

```markdown
{{tools:read,edit,write,patch,replace}}
```

Plain `{{name}}` placeholders keep their existing meaning; unknown names are
left verbatim.

### Fail-open

A malformed override must never blank the identity prompt, so every error path
keeps the text and drops only the marker:

- an unknown attribute or malformed condition is treated as **true**
- a stray `ws:else` / `ws:end` drops the marker; the surrounding text stays
- an unclosed `ws:if` emits every branch's content in source order
- rendering with no request context keeps **all** gated sections — this is the
  view an embedder reading `LAYER_1_IDENTITY` directly gets

The bundled identity and a repo-committed `.wrongstack/instructions/system.md`
are rendered *separately* before being joined, so an unclosed block in project
text can never swallow the real identity above it.

`packages/cli/tests/system-prompt-phantom-tools.test.ts` renders all three
variants against the full builtin tool set and against TIER1-only, and fails if
any tool named in a `ws:if tool=` condition is still described when it is
absent. Adding a new tool section without gating it will trip that test.

## Builtin Sections

The initial file-backed sections cover the durable tool guidance previously
embedded in `DefaultSystemPromptBuilder`:

- `tool.common.patterns`
- `tool.delegation.compact`
- `tool.delegation.full`
- `tool.delegation.launch-preface` — appended to `SubagentConfig.systemPromptOverride` on the **first** `delegate` attempt only. Carries the blocking-vs-async escalation rule: if the worker judges the task will run for tens of minutes or hours, it should tell the leader via `session_note` (same session) or mailbox (cross-session) so the leader can re-dispatch via `spawn_subagent` + `assign_task`. Handoffs receive the same guidance through `buildHandoffTask` instead, so the preface is not re-injected on continuations. The leader's brief (`TaskSpec.description`) is preserved verbatim — the preface never rewrites the runner's task input.
- `tool.mailbox.compact`
- `tool.mailbox.full`
- `tool.session.note.compact` — same-session in-process talk (`session_note`); prefer over mailbox when the other party is in this session
- `tool.session.note.full`
- `tool.commit.hygiene`
- `tool.mcp.compact.use`
- `tool.mcp.compact.control`
- `tool.mcp.full.use`
- `tool.mcp.full.control`
- `tool.context.management.compact`
- `tool.context.management.full`

## Agent Prompts

Fleet/subagent role prompts live in `packages/core/instructions/agents/` and are
loaded by id, for example:

- `agents/explore.md`
- `agents/code-reviewer.md`
- `agents/tech-stack.md`
- `agents/tech-stack-watchdog.md`
- `agents/acp-cline.md`

The TypeScript catalog keeps routing metadata, tool allowlists, budgets, names,
and keywords in code; the long role instructions live in Markdown.

Agent prompt override lookup checks:

1. `WRONGSTACK_AGENT_INSTRUCTIONS_DIR`
2. `~/.wrongstack/profiles/<name>/instructions/agents`
3. bundled `packages/core/instructions/agents`

## Mode And Helper Prompts

Built-in modes keep metadata in TypeScript but load their prompt bodies from
`packages/core/instructions/modes/`.

Internal helper LLM prompts live in `packages/core/instructions/llm/`, for
example:

- `llm/prompt-enhancer.md`
- `llm/llm-selector.md`
- `llm/agent-router.md`
- `llm/autonomy-brain.md`
- `llm/intelligent-compactor-summarizer.md`

Director and autonomy templates are also file-backed:

- `coordination/director-preamble.md`
- `coordination/subagent-baseline.md`
- `autonomy/active-mission.md`
- `autonomy/goal-preamble.md`
- `goal/phase-planner.md`
- `sdd/decompose-task.md`
- `sdd/merge-conflict-resolver.md`
- `security-scanner/generate-skill.md`
- `security-scanner/analyze-batch.md`
- `security-scanner/synthesize-report.md`
- `cli/commit-message.md`
- `cli/goal-refiner.md`
- `cli/next-task-predictor.md`
