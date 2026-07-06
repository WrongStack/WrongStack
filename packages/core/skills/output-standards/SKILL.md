---
name: output-standards
description: |
  Use this skill when defining or enforcing output formatting standards for agent
  responses in WrongStack. Triggers: user says "next steps format", "output standard",
  "response format", "final message format", "standardize next steps".
version: 1.0.0
---

# Output Standards — WrongStack

Standardizes the format of agent output, particularly the `next_steps` section
in final messages. This ensures system-level parsing and automation can reliably
extract structured data from agent responses.

## Rules

1. **Only the leader agent's final message SHOULD include `<nextsteps>`** — subagents report findings only. If nothing is pending, omit the tag entirely; do not append a loose "next steps" or goodwill-style follow-up line.
2. **Any suggested next prompt MUST be inside `<nextsteps>...</nextsteps>`** — never emit parseable-looking prose such as "Next steps:", "next suggests", "Suggested next:", or "Let me know if you want..." when you intend `/next` to work.
3. **`<nextsteps>` is for prompt options only** — every item must be something the user can type into the prompt and submit. If a step is a human-only action (e.g., "open DevTools", "check the browser console"), put it outside the tag as informational text instead.
4. **Tags must be properly closed** — `<nextsteps>...</nextsteps>` with exact tag names.
5. **No markdown inside tags** — plain text only, one item per line.
6. **Items are prompt inputs** — not imperative instructions. Write what the user would type, not what they should do.
7. **Items marked `auto="true"` must include input content** — the user can copy and submit it directly.
8. **Keep concise** — max 5 items unless the task genuinely requires more.
9. **Skip `<nextsteps>` whenever the live `ctx.todos` list still has open items** — any `pending` or `in_progress` todo means the in-flight task list is not done, and surfacing new prompt options would race the todo loop (YOLO+auto could pick the top suggestion and pivot away from the unfinished work; `/next 1` would replace the next todo with an arbitrary prompt). Finish the todo list first, re-arm the tag on the turn where the last todo flips to `completed`. The runtime enforces the same gate, so emitting it mid-task is parsed-and-discarded — the rule exists to keep the output focused, not to override runtime behavior.

## Output Format

```
[... task results ...]

<nextsteps>
1. Prompt option the user can enter — phrased as what to type, not what to do
2. Another prompt option
</nextsteps>

Informational text for human-only actions (outside the tag, no tag wrapper).
```

### Format Requirements

| Element | Rule | Example |
|---------|------|---------|
| Opening tag | `<nextsteps>` on its own line | `<nextsteps>` |
| Numbered items | `1. ` prefix, one per line | `1. Fix auth bug in core/session.ts` |
| Closing tag | `</nextsteps>` on its own line | `</nextsteps>` |
| `auto="true"` items | Include the full input content | `1. fix in core/auth.ts:42 auto="true"` |

### ✅ Correct Examples

```
Bug Hunt complete. Found 3 critical issues.

<nextsteps>
1. Fix the shell injection in packages/cli/src/slash-commands/dev.ts:15
2. Replace Math.random() with randomUUID() in the affected files
3. Run the type checker
</nextsteps>

Open browser DevTools → Network tab to verify the WebSocket
connection is established before testing.
```

```
Audit complete. Found bash command timeout pattern in iterations 14–20.

<nextsteps>
1. Run the session tests and the type checker
</nextsteps>

Review iterations 14–20 in the session log to characterize the loop.
```

### ❌ Incorrect Examples

```
Task done. Next steps: 1) fix bug 2) run tests

# ❌ No tags — not parseable
```

```
<nextsteps>
- Fix the bug in auth.ts  # ❌ Dash, not number
- Run tests
</nextsteps>

# ❌ Wrong bullet character
```

```
<nextsteps>
1. **Fix the bug** — use execFile instead  # ❌ Markdown inside tags
2. Run `pnpm test`
</nextsteps>

# ❌ Markdown formatting not allowed inside tags
```

```
Next steps:
1. Fix auth.ts

# ❌ Missing opening/closing tags
```

```
<nextsteps>
1. Open the browser console and check for errors  # ❌ Human-only action, not a prompt
</nextsteps>
```

## `auto="true"` Format

Items that should be auto-submitted (the user can copy-paste and send) use `auto="true"`:

```
<nextsteps>
1. Run the type checker auto="true"
2. Fix the shell injection in packages/cli/src/slash-commands/dev.ts:15
</nextsteps>
```

The text before `auto="true"` is the exact prompt the user would type. Items without `auto="true"` are suggestions the user can select manually.

## Subagent Requirements

When a **leader agent** synthesizes output from **subagents**, the leader MUST:

1. Collect findings from subagents (they return results, not `<nextsteps>`)
2. Based on findings, produce a unified `<nextsteps>` section with prompt options
3. Remove duplicates (dedupe by file path + action)
4. Re-prioritize if needed (critical > high > medium > low)
5. Human-only findings (e.g., "check the browser console") go outside the tag
6. Keep the unified list within the 5-item guideline, but no hard cap

When a **subagent** completes its task, it MUST:

1. **NOT include `<nextsteps>`** in its output — report findings only
2. Report what it found/achieved in a structured, self-contained format
3. Let the leader decide what next steps follow from the findings

## Anti-patterns

- **Don't put human-only actions in `<nextsteps>`** — those belong outside the tag as plain text
- **Don't write imperative instructions** — write what the user would type, not what they should do
- **Don't use markdown inside `<nextsteps>`** — plain text only
- **Don't skip the tag when there are prompt options** — the tag enables the `/next` workflow
- **Don't use dashes or asterisks** — use `1.`, `2.`, `3.` numbering
- **Don't be vague** — "fix bugs" is useless, "fix auth/session.ts:42" is a valid prompt
- **Don't exceed 5 items without reason** — if >5, it's probably not a single task
- **Don't write declarations of intent** — "we should refactor X" is not a prompt; "refactor core/config.ts" is
- **Don't suggest manual review as a prompt** — "manually check if X is correct" is not a valid LLM prompt; instead put it outside the tag
- **Don't include `<nextsteps>` in subagent output** — subagents report findings, leaders produce next steps

## Skills in scope

- `bug-hunter` — inherits output-standards for bug reports
- `security-scanner` — inherits output-standards for security findings
- `refactor-planner` — inherits output-standards for refactoring plans
- `architect` — inherits output-standards for architecture analysis
- `tech-stack` — inherits output-standards for dependency reports
