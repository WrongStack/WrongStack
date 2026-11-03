# Output Standards — WrongStack (Compact)

<!-- source-version: 1.2.2 -->

## Selection card
- Task: Apply precise evidence and response formatting. / TR: Kesin kanıt ve yanıt biçimini uygula.
- Start: Identify which output contract applies: final message, next_steps block, auto mode or subagent report.
- Finish: The response matches the contract exactly, including parser-sensitive markers, with no invented options or claims.

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

## Detailed workflow

Load the full output-standards skill before relying on its specialized modes,
references or output contracts. Its current SKILL.md is the source of truth;
this compact body does not expand task scope or authorization.

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
