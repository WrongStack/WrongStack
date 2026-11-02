# Skill Creator — WrongStack (Compact)

<!-- source-version: 1.5.0 -->

## Selection card
- Task: Author and validate bundled or project skills. / TR: Bundled veya proje skilli yaz ve doğrula.
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

## Detailed workflow

Load the full skill-creator skill before relying on its specialized modes,
references or output contracts. Its current SKILL.md is the source of truth;
this compact body does not expand task scope or authorization.

## Before returning

- [ ] Destination, name, description, trigger, and audience metadata verified
- [ ] Required surfaces exist and optional integrations have a real fallback
- [ ] Linked resources load and changed helpers execute successfully
- [ ] Behavioral checks distinguished from structural checks
- [ ] Catalogs synchronized; verification results and unknowns reported
