---
name: skill-router
description: "Choose the correct bundled WrongStack skill and order a multi-step workflow. Use for an unclear request, overlapping skill descriptions, or work combining design, web/mobile, video, backend and deployment. Exact single-technology tasks should load their specialized skill directly."
trigger: "choose skills, hangi skill, ne kullanmalı, mixed design/video/mobile/deploy workflows, unclear task routing"
version: 1.0.0
required-capabilities: [filesystem.read]
required-tools: [skill]
optional-capabilities: []
metadata:
  routing-group: workflow
---

# Bundled Skill Router

## Selection card
- Task: select a small, ordered skill pipeline for an ambiguous or multi-domain request.
- Start: extract the requested result, exact technology, action and acceptance check.
- Finish: load each selected skill before its phase and verify the delivered result.

## Rules

1. Select by requested action and exact platform, not a vaguely similar name.
   A simple explanation, translation or greeting often needs no skill.
2. For a clear single task, load its specialized skill directly. Use this router
   when scope is unclear or several skills overlap. Do not load the whole catalog.
3. Read the task's group in [the selection map](references/selection-map.md).
   It covers all bundled ids, including audience-restricted entries. Use only
   skills offered in this agent's manifest; restricted entries are not fallbacks.
4. Read [overlap decisions](references/overlap-decisions.md) for neighboring
   skills. Preserve the existing project's engine when it fits the request.
5. Load the selected instructions through the `skill` tool. Follow continuation
   pages and the resources needed for this task before implementing its steps.
6. Current versions are a lookup procedure, not a remembered constant. For a new
   setup or upgrade, use tech-stack to verify stable registry releases, runtime,
   peer and adapter compatibility. Record dated sources and blockers.
7. A skill does not grant permission, tools, delegation, credentials or network
   access. Preserve the host's gates. Missing capabilities require a stated
   constraint or a genuinely applicable narrower workflow.
8. Complete the specialist's acceptance checks. If a build/render/deploy/restore
   did not run successfully, report it as unverified rather than done.

## Workflow

1. Write a compact task frame: result + platform + operation + success evidence.
2. Pick one primary specialist. Add supporting skills only for distinct steps.
3. Execute in dependency order: scope/design, implementation/assets, integration,
   verification, then release only when the task authorizes it.
4. On failure, use debugging for a reported defect; use evidence-audit for an
   authorized hunt for unknown defects. Recheck the original acceptance path.
5. Report the artifact or behavior delivered, the checks actually run and gaps.

## Examples

- Next.js product page with animated UI: nextjs-modern → design-craft →
  motion-design → accessibility and relevant testing. These are live UI motions.
- Product demo video: media-production for Remotion or FFmpeg; add
  motion-canvas-video for a scripted diagram, manim-video for a mathematical shot,
  audio-studio for narration. Verify the encoded artifact, not just the preview.
- Mobile checkout: the project's native framework → mobile-design →
  payments-webhooks for server callbacks → mobile-performance → mobile-release.
- Containerized VPS release: docker-deploy → compose-operations when needed →
  vps-deploy → reverse-proxy-tls → release-rollback. Verify target health.

## Before returning

The primary skill fits the action and technology; no hidden or unavailable skill
was recommended; each completed phase has its own observed acceptance evidence.

## Skills in scope

- tech-stack — stable versions, migration and compatibility.
- codebase-navigation — find the actual implementation boundary.
- debugging — diagnose an observed failure.
- verify-before-done — verify the original completion claim.
