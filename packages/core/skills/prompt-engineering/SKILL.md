---
name: prompt-engineering
description: |
  Use this skill when designing, critiquing, or fixing system prompts, tool descriptions, skill definitions, or other LLM instruction text — including when a model ignores, over-applies, or misreads its instructions.
  Triggers: user mentions "prompt", "system prompt", "system instruction", "tool description", "skill description", "few-shot", "the model keeps ignoring", "eval", "usage hint".
version: 2.1.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run]
trigger: "Use this skill when designing, critiquing, or fixing system prompts, tool descriptions, skill definitions, or other LLM instruction text \u2014 including when a model ignores, over-applies, or misreads its instructions."
metadata:
  routing-group: workflow
---

# Prompt Engineering

## Selection card
- Task: Design grounded instructions and output contracts.
- Start: Identify the requested artifact, repository owner and acceptance criteria.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Current models follow instructions closely, so most prompt failures are
failures of clarity, not of emphasis: a missing reason, a buried or
contradictory rule, an example that teaches the wrong thing, or a tool whose
purpose overlaps another. Write prompts the way you would brief a capable new
colleague who has none of your context, then check them against real inputs.

## Rules

1. State the goal and the reason. A rule with its "why" generalizes to cases
   the rule didn't list; a bare rule gets applied literally.
2. Say what good output looks like — format, length, audience, and when the
   task is done. Prefer "do X" over a list of things not to do.
3. Use examples deliberately. They are copied closely, so make them varied,
   representative, and consistent with the written rules.
4. Structure long prompts. Separate instructions, context, and data with
   headings or XML-style tags; put long reference material before the question
   that uses it.
5. Calibrate emphasis. Capitals and "CRITICAL" on every line make a model
   over-apply rules to cases they were never meant for; reserve strong wording
   for genuine hard constraints.
6. Remove filler and resolve contradictions. Every sentence should change
   behaviour; when two instructions can conflict, state which wins.
7. Order for caching: stable content (identity, tools, standing rules) first,
   volatile content (session state, recent errors) last.
8. Test against a fixed set of inputs, including edge cases and inputs the
   prompt should decline. Change one thing at a time and read the outputs, not
   just a score.

## Tool descriptions

A model picks tools from their names and descriptions alone. Each description
answers:

- **When to use it — and when not.** Name the neighbouring tool to prefer
  instead ("for exact text use grep; for symbols use this").
- **Inputs.** Required versus optional, formats, units, limits, and one
  concrete example value for anything non-obvious.
- **Output.** The shape of what comes back, so the next step can be planned.
- **Failure.** What errors look like and what to do about them.

```text
✅ Search indexed code symbols by name or concept and return ranked definitions
   with file and line. Use before broad grep when locating a function, type, or
   module; use grep for exact strings or regexes. `kind` narrows to functions,
   classes, or interfaces. If the index is empty, build it first.

❌ Searches the codebase.
```

## Skill descriptions

The description decides whether a skill is ever loaded, so it is written for
selection, not for documentation:

- The first sentence is the trigger shown in the skill manifest — a concrete
  situation ("when writing or fixing tests in any project"), not a topic ("this
  skill is about tests").
- Follow with the phrases users actually type, including symptoms
  ("flaky", "keeps failing"), not only the formal names.
- Scope it honestly. An over-broad trigger crowds out better skills; one that
  says "in <product>" may never fire for the user's own project.
- In WrongStack skill bodies, a tool name wrapped in backticks, or "use/run/call"
  followed by a backticked name, is treated as a required tool — the skill is
  dropped where that tool is absent. Write optional tool names in plain text.

## Diagnosing a misbehaving prompt

| Symptom | Likely cause | Fix |
|---|---|---|
| Ignores an instruction | Buried in a long block, or contradicted elsewhere | Move it near the task, remove the conflict, give the reason |
| Applies a rule where it doesn't fit | Absolute or shouted wording | State the scope and the exception; drop the capitals |
| Output format drifts | No example or schema | Show one exact example, or require a schema |
| Too verbose or too terse | No length or audience guidance | State the reader and the expected length |
| Calls the wrong tool | Overlapping tool descriptions | Add "use X instead when…" to both |
| Invents facts | No permission to say "unknown" | Tell it what to do when information is missing |

## Anti-patterns

- **Identity filler** ("You are a helpful assistant") and politeness padding —
  they cost tokens and change nothing.
- **Rules without reasons**, so edge cases are guessed.
- **Examples that contradict the rules** — the example wins.
- **Fixing one bad output by adding one more rule**, until the prompt is a pile
  of patches; find the underlying ambiguity instead.
- **Judging a prompt change from a single run.**

## Before returning

- [ ] Goal, reasons, and success criteria stated
- [ ] No contradictions; precedence stated where rules can conflict
- [ ] Examples consistent with the rules and varied
- [ ] Emphasis reserved for real hard constraints
- [ ] Tool and skill descriptions say when to use, inputs, outputs, and alternatives
- [ ] Checked against representative and edge-case inputs

## Behavioral evaluation

Pin realistic inputs and observable success criteria before changing a prompt.
Include near-miss activation cases, ambiguous instructions and untrusted source
text. Compare tool choice, task completion and output validity against the old
prompt; regex/phrase presence alone is structural evidence.
Record model/version/settings and repeated-run variability for meaningful
quality claims. Instructions cannot substitute for runtime validation or permissions.

## Skills in scope

- `skill-creator` — for the WrongStack SKILL.md format and authoring workflow
- `output-standards` — for WrongStack's final-message and `<nextsteps>` conventions
- `testing` — for turning prompt checks into repeatable evaluations
