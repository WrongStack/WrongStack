---
name: skill-creator
description: |
  Use this skill when the user wants to create a new AI skill in WrongStack.
  Triggers: user says "create a skill", "new skill", "add a skill", "skill definition".
version: 1.2.0
---

# Skill Creator — WrongStack

## Overview

Guides the creation of new WrongStack skills. A skill is a Markdown file with YAML frontmatter — the first sentence of the description is the trigger. You are the wizard: ask questions, validate answers, write the file. Use the `/skill-gen` sub-commands to do the mechanical parts (validation, scaffolding) deterministically.

## Rules

1. First sentence of `description` = trigger — this is the only thing the skill loader matches on.
2. Name must be kebab-case: `my-skill`, `docker-deploy` — lowercase, hyphens only.
3. Skills live in `.wrongstack/skills/<name>/SKILL.md` (project level).
4. After the trigger sentence, add `Triggers: user says "X", "Y", "Z".`.
5. Content must be actionable — rules, patterns, anti-patterns, not just prose.
6. End with "Skills in scope" listing related skills for delegation.
7. Don't let skill names collide with existing skills.

## Authoring commands (use these)

The `/skill-gen` command is a toolkit — pick the right sub-command for the job instead of writing files by hand:

| Sub-command | When to use |
|---|---|
| `/skill-gen` (bare) | Open-ended creation: you (the agent) ask questions one at a time, then write the file. Best for nuanced skills. |
| `/skill-gen skeleton <name> --desc "..." --trigger a,b` | Quick scaffold: generates a valid SKILL.md skeleton the user edits. Use when the name + trigger are already known. |
| `/skill-gen from-prompt "<text>"` | Turn an existing prompt/instruction into a skill draft. Use when the user hands you a prompt and says "make this a skill". |
| `/skill-gen validate <name>` | Validate a name (format + collisions) before writing. **Always run this before creating a file.** |
| `/skill-gen view <name>` | Read-only: show a skill's body. |
| `/skill-gen edit <name>` | Open the skill in `$EDITOR`/`$VISUAL`. |
| `/skill-gen list` | List skills with their source layer. |

After writing a skill with the wizard flow, run `/skill-gen validate <name>` to confirm it loads cleanly.

## Patterns

### Do

```markdown
---
name: docker-deploy
description: |
  Use this skill when deploying Docker containers to a production cluster.
  Triggers: user says "docker", "container", "deploy", "dockerfile", "image".
version: 1.0.0
---

# Docker Deploy — WrongStack

## Overview
...
## Rules
...
## Patterns
...
## Skills in scope
```

### Don't

```markdown
---
name: MySkill # ❌ PascalCase
name: my_skill      # ❌ underscore
description: |
  This skill is about Docker.  # ❌ no trigger sentence
---
```

## Skill format

Every skill is a Markdown file with YAML frontmatter:

```markdown
---
name: my-skill-name
description: |
  Use this skill when <trigger situation>.
  Triggers: user says "keyword", "another keyword".
version: 1.0.0
---

# Skill Title

## Overview
What this skill does.

## Rules
- Rule 1
- Rule 2

## Patterns
### Do
\`\`\`ts
// good example
\`\`\`

### Don't
\`\`\`ts
// bad example
\`\`\`

## Workflow
1. Step one
2. Step two
```

## File structure

A skill is a directory containing `SKILL.md` plus optional resource subdirectories (the agentskills.io layout):

```
<name>/
  SKILL.md            ← required: metadata + instructions
  scripts/            ← optional: executable code (run via bash)
  references/         ← optional: docs loaded on demand (REFERENCE.md, …)
  assets/             ← optional: templates, data, snippets
  …                   ← any other subdirectories
```

Skills live under these paths (priority order, first-seen wins by name):

1. **Project**: `<project>/.wrongstack/skills/<name>/`
2. **Project foreign**: `<project>/.claude/skills/<name>/`, `<project>/.{codex,cursor,agents,…}/skills/<name>/`
3. **User global**: `~/.wrongstack/skills/<name>/`
4. **User foreign**: `~/.claude/skills/<name>/`, `~/.{codex,cursor,agents,…}/skills/<name>/`
5. **Bundled**: `packages/core/skills/<name>/` (read-only, core team)

For user-created skills: always use path 1 (project level).

## Resource files (scripts / references / assets)

Bundled resources are NOT injected into the prompt — the agent loads them on demand via the `skill` tool (agentskills.io progressive disclosure, tier 3):

- `skill({ name: "<name>" })` → lists every bundled file (scripts/, references/, assets/, any subdir, recursively).
- `skill({ name: "<name>", resource: "references/REF.md" })` → returns that file's content. Scripts come back with an absolute path so the agent runs them via `bash`.

Keep `SKILL.md` under ~500 lines; move deep reference material into `references/`. Reference files with relative paths from the skill root. Scripts must be self-contained and safe to run. Only add the subdirectories a skill actually needs — empty directories don't persist in git, so create a file (e.g. `scripts/README.md`) if you want the directory tracked.

## Workflow

1. **Ask the name** — suggest kebab-case, validate format
2. **Ask the trigger** — "What situation should activate this skill?"
3. **Ask the coverage** — what rules, patterns, workflows?
4. **Generate the SKILL.md** — write to `.wrongstack/skills/<name>/SKILL.md`
5. **Confirm** — show the path, remind them to use `/skill` to list skills

## Validation Checklist

Before writing the file, verify:
- [ ] Name is valid kebab-case
- [ ] Name doesn't collide with existing skills
- [ ] Description has a clear trigger sentence
- [ ] Content is actionable (rules, patterns, not just prose)
- [ ] File will be placed in `.wrongstack/skills/`

## Skills in scope

- `prompt-engineering` — for crafting the skill description and prompt text
- `git-flow` — for committing the new skill file
- `output-standards` — for standardized `<nextsteps>` formatting