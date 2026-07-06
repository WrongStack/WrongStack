---
name: prompt-engineering
description: |
  Use this skill when designing, critiquing, or fixing system prompts,
  tool descriptions, skill definitions, or LLM instruction text in WrongStack.
  Triggers: user mentions "prompt", "system instruction", "skill description", "tool hint", "usage hint", "system prompt".
version: 1.1.0
---

# Prompt Engineering — WrongStack

## Overview

Designs, critiques, and fixes system prompts, tool descriptions, and skill definitions for LLM agents. WrongStack uses a 4-layer prompt structure — static content first, volatile last for cache efficiency.

## Rules

1. Static content first, volatile last — cache-friendly prompts cost less per token.
2. First sentence of skill description = trigger — keep it specific and actionable.
3. Tool descriptions must say: when to use, key parameters, what it returns.
4. Remove filler ("Please be helpful", "Sure, I'd be happy to") — wastes tokens.
5. Always read before edit — agents should grep/read first, then edit.
6. Skill descriptions should list specific trigger keywords, not generic descriptions.

## Patterns

### Do

```markdown
# ✅ Good — specific trigger
Use this skill when writing or reviewing React 19+ code.

# ✅ Good — tool description with all three parts
Search file contents with regex. Pattern is regex. Use output_mode to select
content (matched lines), files_with_matches (file list), or count (line counts).
Always read before edit — grep first to locate the target.

# ✅ Good — skill description with trigger keywords
Use this skill when designing system prompts or tool descriptions
for LLM agents. Covers structure, specificity, and common pitfalls.
Triggers: user mentions "prompt", "system instruction", "tool hint".
```

### Don't

```markdown
# ❌ Bad — vague trigger
This skill is about Docker.

# ❌ Bad — filler
Please be helpful and use your best judgment.

# ❌ Bad — tool description missing parameters
Search files using grep.
```

## WrongStack's 4-layer structure

```
Layer 1: Identity     — Who you are (static, cacheable)
Layer 2: Tool usage   — Available tools and their usage hints (static)
Layer 3: Environment  — Project context, skills, modes, plan (semistatic)
Layer 4: Volatile     — Session state, recent errors, mode prompt (dynamic)
```

Static content first. Volatile content last. Cache-friendly prompts cost less per token.

## Trigger sentences (skill descriptions)

The **first sentence** of a skill description is its trigger. This is the only thing the skill loader matches on.

```
# Good — specific trigger
Use this skill when deploying Docker containers to staging.

# Bad — vague
This skill is about Docker.

# Good — pattern matchable
Use this skill when writing or reviewing React 19+ code.

# Bad — not actionable
This skill covers modern React patterns.
```

## Tool description rules

Every tool in WrongStack has: `name`, `description`, `usageHint`, `inputSchema`.

The `usageHint` is what appears in the system prompt. It must say:
1. **When to use it** — not just what it does
2. **Key parameters** — the important inputs
3. **What it returns** — so the model knows what to do next

```
# Good
Search file contents with regex. Pattern is regex. Use output_mode to select
content (matched lines), files_with_matches (file list), or count (line counts).
Always read before edit — grep first to locate the target.

# Bad
Search files using grep.
```

## Common tool chain patterns (for system prompt builder)

```
Inspect → Edit:    glob/read → locate → edit
Search → Operate:   grep/glob → identify → batch_tool_use or edit
Verify → Report:    write/edit/patch → read back → confirm
Batch Replace:     grep with pattern → replace with glob → verify
```

## Anti-patterns

| Anti-pattern | Why it's bad | Fix |
|---|---|---|
| "Please be helpful" | Wastes tokens, implies the model isn't | Remove it |
| "You are a helpful AI" | Already implied by default identity | Remove it |
| "Sure, I'd be happy to" | Same — filler, no information | Remove it |
| Vague parameter docs | Model doesn't know when to use tool | Add concrete examples |
| Long preamble before the question | Model reads it, then reads the actual question | Put question first |
| Ambiguous pronouns | "do it again" — which tool, which file? | Name the specific thing |

## Skill SKILL.md rules

See `skill-creator` skill for the format. Key points:
- First sentence = trigger condition
- Include concrete code examples in "Do" and "Don't" sections
- End with "Skills in scope" so agents know to delegate

## Skills in scope

- `skill-creator` — for creating new skills (primary — prompt-engineering feeds into skill creation)
- `typescript-strict` — for TypeScript-specific prompt typing
- `react-modern` — for React component prompt conventions
- `output-standards` — for standardized `<nextsteps>` formatting