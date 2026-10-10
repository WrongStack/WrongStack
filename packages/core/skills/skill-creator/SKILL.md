---
name: skill-creator
description: "Create, improve and validate WrongStack SKILL.md bundles with precise discovery, progressive resources and current runtime contracts. Use when authoring skills, improving triggers or maintaining bundled skills; respect the requested destination and preserve existing audience and capability metadata."
version: 1.4.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
trigger: "authoring skills, improving triggers or maintaining bundled skills; respect the requested destination and preserve existing audience and capability metadata."
optional-capabilities: [verification.run, web.research]
metadata:
  routing-group: workflow
---

# Skill Creator — WrongStack

## Selection card
- Task: Author and validate bundled or project skills.
- Start: Identify the requested artifact, repository owner and acceptance criteria.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Skills guide the agent; the runtime owns tool schemas, permissions and execution.
Write instructions that change useful decisions, then validate discovery,
resources and behavior. The [Agent Skills specification](https://agentskills.io/specification)
was reviewed on 2026-10-09; WrongStack adds audience and runtime capability fields.

## Rules

1. Use a 1–64 character lowercase kebab-case name matching its directory.
   Description is 1–1024 characters and states capability plus activation context.
2. Respect the requested destination. Default new project skills to
   .wrongstack/skills/<name>/SKILL.md; bundled maintenance belongs in
   packages/core/skills/<name>/SKILL.md when that is the user's requested scope.
3. Preserve supported audience, metadata and extension fields. Intentional
   shadowing is valid; accidental same-layer overwrite is not.
4. Keep the entrypoint below 200 lines as an authoring target. Move substantial
   conditional workflows to linked resources; keep essential scope, stopping
   conditions and authorization in the entrypoint.
5. Verify latest stable technology targets from official sources. Record exact
   version/date/URL and refresh before installs; no version guesses or stale
   examples presented as current.
6. Declare only real runtime requirements. Optional tools should appear in
   plain prose: backticked canonical names are inferred as required by the
   prompt builder even when the sentence says “optional”.

## Workflow

1. Read existing skills, loader, consumers and nearest tests. Identify realistic
   positive and negative activation cases; avoid catchall descriptions.
2. Preserve the skill's actual role: reviewer, planner, operator or implementer.
   An implementation request should not stop at a plan unless scope requires it.
3. Write essential decisions, representative patterns, observable completion
   checks and proportionate fallback behavior. Do not add scripts, templates or
   directories without a concrete use.
4. Link each resource from the entrypoint with when to read it. In progressive
   mode, load through the skill tool using name/resource/offset and continue
   pages until nextOffset is absent.
5. Validate with /skill-gen validate <name> in a running WrongStack session.
   For bundled source maintenance, run the checker below. A filesystem shell
   cannot execute slash commands directly.
6. Check actual discovery/body/resource loading and meaningful scenarios.
   Structural validation alone does not prove improved model behavior.
7. Bump the informational skill version for changed behavior. Update catalogs
   through their official writers and preserve parser-sensitive output formats.

## Bundle check

From the repository root:

~~~powershell
bun run packages/core/skills/skill-creator/scripts/check-bundle.ts
~~~

This helper checks frontmatter, real tool/capability names, related skill
targets, local resource links and runtime discovery. It does not install
dependencies, change files or invoke a model.

## Optional authoring surfaces

Use the host's /skill-gen skeleton, from-prompt, validate, view, edit and list
commands when relevant. After manual writes, /skill reload refreshes discovery;
/skill use <name> <task> activates instructions, while a preview is only a preview.

Discovery order is project WrongStack, project foreign, user/profile, user
foreign, configured extra directories, then bundled; first name wins.
Use installed source to confirm enabled foreign layers and ordering.

## Before returning

- Destination, name, description and audience correct.
- Required surfaces exist; optional integrations have a real fallback.
- Linked resources load and changed helpers execute successfully.
- Behavioral checks distinguished from structural checks.
- Catalogs synchronized; verification results and unknowns reported.

## Skills in scope

- prompt-engineering — discriminating triggers and instruction contracts.
- testing — meaningful authoring and loading checks.
- tech-stack — version verification.
- output-standards — parser-compatible response formats.
