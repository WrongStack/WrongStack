---
name: output-standards
description: |
  Use this skill when defining or enforcing output formatting standards for agent
  responses in WrongStack. Triggers: user says "next steps format", "output standard",
  "response format", "final message format", "standardize next steps".
version: 1.1.0
required-capabilities: []
required-tools: []
---

# Output Standards — WrongStack

Standardizes the format of agent output, particularly the `next_steps` section
in final messages. This ensures system-level parsing and automation can reliably
extract structured data from agent responses.

## Rules

1. **Only the leader agent's final message SHOULD include `<nextsteps>`** — subagents report findings only. If nothing is pending, omit the tag entirely; do not append a loose "next steps" or goodwill-style follow-up line.
2. **Any suggested next prompt MUST be inside `<nextsteps>...</nextsteps>`** — never emit parseable-looking prose such as "Next steps:", "next suggests", "Suggested next:", or "Let me know if you want..." when you intend `/next` to work.
3. **`<nextsteps>` is for prompt options only** — every item is the exact natural-language message that can be submitted back to the agent through the current TUI or WebUI prompt input. It asks the agent to perform work; it is not a checklist of work the user must do. Human-only actions (e.g., "open DevTools yourself", "manually check the browser console") belong outside the tag as informational text.
4. **Tags must be exact and properly closed** — `<nextsteps>...</nextsteps>` with no attributes on either tag. In particular, never emit `<nextsteps auto="true">`.
5. **No markdown inside tags** — plain text only, one item per line.
6. **Items are agent-directed prompt inputs** — imperative wording is valid when it tells the agent what to do. Write the complete message the user would send, not an instruction addressed to the user.
7. **Only item 1 may be marked `auto="true"`** — at most one item may carry the marker, and its input must be complete enough to submit directly.
8. **Keep concise** — max 5 items unless the task genuinely requires more.
9. **Skip `<nextsteps>` whenever the live `ctx.todos` list still has open items** — any `pending` or `in_progress` todo means the in-flight task list is not done, and surfacing new prompt options would race the todo loop (YOLO+auto could pick the top suggestion and pivot away from the unfinished work; `/next 1` would replace the next todo with an arbitrary prompt). Finish the todo list first, re-arm the tag on the turn where the last todo flips to `completed`. The runtime enforces the same gate, so emitting it mid-task is parsed-and-discarded — the rule exists to keep the output focused, not to override runtime behavior.

## Output Format

```
[... task results ...]

<nextsteps>
1. Run the focused parser tests and fix any failures
2. Review the current diff and implement any necessary corrections
</nextsteps>

Informational text for human-only actions (outside the tag, no tag wrapper).
```

### Format Requirements

| Element | Rule | Example |
|---------|------|---------|
| Opening tag | `<nextsteps>` on its own line | `<nextsteps>` |
| Numbered items | `1. ` prefix, one agent-directed prompt per line | `1. Fix the auth bug in core/session.ts and add a regression test` |
| Closing tag | `</nextsteps>` on its own line | `</nextsteps>` |
| `auto="true"` item | Optional on item 1 only; include the full input content | `1. fix in core/auth.ts:42 auto="true"` |

### ✅ Correct Examples

```
Bug Hunt complete. Found 3 critical issues.

<nextsteps>
1. Fix the shell injection in packages/cli/src/slash-commands/dev.ts:15
2. Replace Math.random() with randomUUID() in the affected files
3. Run the type checker and fix any errors
</nextsteps>

Open browser DevTools → Network tab to verify the WebSocket
connection is established before testing.
```

```
Audit complete. Found bash command timeout pattern in iterations 14–20.

<nextsteps>
1. Run the session tests and type checker, then fix any failures
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

When the first item should be auto-submitted, append `auto="true"` to that item. Never put it on the `<nextsteps>` tag or on items 2+:

```
<nextsteps>
1. Run the type checker and fix any errors auto="true"
2. Fix the shell injection in packages/cli/src/slash-commands/dev.ts:15 and add a regression test
</nextsteps>
```

The text before `auto="true"` is the exact prompt the user would type. There can be at most one auto item and it must be item 1. Items without `auto="true"` are suggestions the user can select manually.

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
- **Don't address instructions to the user** — agent-directed imperatives are valid because the selected text is submitted back to the agent verbatim
- **Don't use markdown inside `<nextsteps>`** — plain text only
- **Don't skip the tag when there are prompt options** — the tag enables the `/next` workflow
- **Don't use dashes or asterisks** — use `1.`, `2.`, `3.` numbering
- **Don't be vague** — "fix bugs" is useless, "fix auth/session.ts:42" is a valid prompt
- **Don't exceed 5 items without reason** — if >5, it's probably not a single task
- **Don't write declarations of intent** — "we should refactor X" is not a prompt; "refactor core/config.ts" is
- **Don't assign manual work to the user** — "manually check if X is correct yourself" is not a valid next prompt; when tools permit it, use an agent-directed prompt such as "Use the browser tools to verify X and fix any issue you find"
- **Don't include `<nextsteps>` in subagent output** — subagents report findings, leaders produce next steps

## Out of scope

- **Don't include `<nextsteps>` in subagent output.** Subagents report findings; the leader produces the unified tag. A subagent that emits `<nextsteps>` is stepping on the leader's lane.
- **Don't emit parseable-looking prose instead of the tag.** "Next steps:", "Suggested next:", "Let me know if you want..." all look like the tag to the parser and break the `/next` workflow.
- **Don't put human-only actions in `<nextsteps>`.** "Open DevTools yourself", "manually check the browser console" — those are informational, not agent prompts. They go outside the tag as plain text.
- **Don't put markdown inside the tag.** Plain text only, one item per line. `**bold**`, code spans, headings — all break the parser.
- **Don't use dashes or asterisks inside the tag.** Numbered items only: `1.`, `2.`, `3.`. Dash and asterisk bullets are wrong and silently fail the parser.
- **Don't put `auto="true"` on items 2+.** Only item 1 may carry the marker. The marker on later items is parsed-and-discarded.
- **Don't write vague prompts.** "Fix bugs" is not a prompt; "fix auth/session.ts:42 and add a regression test" is. The selected text is submitted verbatim — vague prompts are vague runs.
- **Don't exceed 5 items without reason.** If the list is over 5, it's probably not a single task. Split it or hand off.
- **Don't emit `<nextsteps>` while `ctx.todos` has open items.** The in-flight todo list isn't done; new prompt options race the todo loop. Finish the list first, re-arm the tag on the turn where the last todo flips to `completed`.
- **Don't address the user inside the tag.** Items are agent-directed prompt inputs. Imperative wording is valid when it tells the agent what to do.

## Before returning

- [ ] Only the leader emits `<nextsteps>`; subagents return findings only
- [ ] Tag is well-formed: `<nextsteps>...</nextsteps>`, no attributes on the tags
- [ ] Plain text only inside the tag; no markdown, dashes, or asterisks
- [ ] Numbered items `1.`, `2.`, `3.`; one prompt per line
- [ ] At most one `auto="true"`, and only on item 1
- [ ] Items are agent-directed prompts, not human-only actions
- [ ] Items are specific enough to submit verbatim (file:line + concrete action)
- [ ] At most 5 items unless a single task genuinely requires more
- [ ] Tag omitted if `ctx.todos` still has pending or in_progress items
- [ ] Leader output synthesized from subagent findings, deduplicated and re-prioritized
- [ ] Human-only actions sit outside the tag as plain text, not inside it

## Skills in scope

- `bug-hunter` — inherits output-standards for bug reports
- `security-scanner` — inherits output-standards for security findings
- `refactor-planner` — inherits output-standards for refactoring plans
- `architect` — inherits output-standards for architecture analysis
- `tech-stack` — inherits output-standards for dependency reports
