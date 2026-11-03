---
name: skill-creator
description: "Write, improve or validate SKILL.md skills: discovery-ready descriptions, frontmatter, references, checker runs and catalogs. Use when authoring skills, improving triggers or maintaining bundled skills; respect the requested destination and preserve existing audience and capability metadata."
version: 1.5.0
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
- Start: Identify the destination layer, the skill's role, and realistic requests that should and should not trigger it.
- Finish: The bundle checker passes and the skill is discovered and loaded for its positive cases.

## Overview

Skills guide the agent; the runtime owns tool schemas, permissions and execution.
Write instructions that change useful decisions, then validate discovery,
resources and behavior. The [Agent Skills specification](https://agentskills.io/specification)
was reviewed on 2026-10-23; WrongStack adds audience and runtime capability fields.

## Rules

1. Use a 1–64 character lowercase kebab-case name matching its directory.
   Description is 1–1024 characters and states capability plus activation context.
   Its first sentence is the catalog row the model chooses from: keep it near
   135 characters and lead with request vocabulary (frameworks, files,
   commands, symptoms), then "Use when …" and a "Not for … (use x)" boundary.
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
   examples presented as current. Phrase stamps the way the tech-stack
   sync-versions writer matches them ("Checked <date>: Python 3.x.y", "Go
   target: 1.x.y"), then `bun run skill:sync-versions` keeps them current.
6. Declare only real runtime requirements. Optional tools should appear in
   plain prose: backticked canonical names are inferred as required by the
   prompt builder even when the sentence says “optional”. So is any single
   backticked word right after use, run, call or invoke, or right before the
   word tool; an unknown one fails the checker. Write multi-word commands
   (`pytest -x -q`) or plain prose.

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
targets, local resource links, runtime discovery and that each progressive
catalog row shows the complete first description sentence. It does not install
dependencies, change files or invoke a model.

## Optional authoring surfaces

Use the host's /skill-gen skeleton, from-prompt, validate, view, edit and list
commands when relevant. After manual writes, /skill reload refreshes discovery;
/skill use <name> <task> activates instructions, while a preview is only a preview.

Discovery order is project WrongStack, project foreign, user/profile, user
foreign, configured extra directories, then bundled; first name wins.
Use installed source to confirm enabled foreign layers and ordering.

## Before returning

- [ ] Destination path, lowercase kebab-case `name`, discriminating `description`, `trigger`, and `audience` metadata are verified.
- [ ] Entrypoint stays within the 200-line ceiling and declares only genuine `required-capabilities` and `required-tools`.
- [ ] All linked `references/*` files exist, load cleanly, and any condensed `SKILL.save.md` matches `<!-- source-version: ... -->`.
- [ ] Behavioral activation and completion checks are distinguished from structural validator checks.
- [ ] Bundle validator (`check-bundle.ts`) and version sync checks pass with zero errors, and any unknowns are reported.

## Skills in scope

- `prompt-engineering` — discriminating trigger phrasing, instruction hierarchy, and anti-slop guardrails
- `testing` — structural and behavioral skill discovery, loading, and contract regression tests
- `tech-stack` — live registry verification for dated version snapshots inside skills
- `output-standards` — parser-compatible report and checklist formatting
