---
name: design-craft
description: |
  Design or substantially improve user-facing interfaces with a product-specific visual direction, content hierarchy, and rendered critique. Use for new screens, landing pages, redesigns, typography/layout work, or UI that feels generic or AI-generated. For small fixes, preserve the existing design without starting a new brief.
version: 2.1.1
required-capabilities: [filesystem.read, filesystem.write]
required-tools: [design, skill]
optional-capabilities: [web.research, browser.interact, verification.run]
trigger: "Design or substantially improve user-facing interfaces with a product-specific visual direction, content hierarchy, and rendered critique. Use for new screens, landing pages, redesigns, typography/layout work, or UI that feels generic or AI-generated. For small fixes, preserve the existing design without starting a new brief."
metadata:
  routing-group: design
---

# Design Craft — WrongStack

The outcome is an interface suited to this product, its content and its users.
Token consistency helps, but cannot establish visual quality. A kit supplies
reusable decisions, not a finished composition. Removing gradients or changing
three cards to four does not make a design original.

## Selection card
- Task: Build or restyle a concrete product interface.
- Start: Identify the target surface, reference, user task and existing tokens.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Establish the design boundary

Inspect the relevant screens, components, theme, assets and framework before
choosing a direction. Reuse an established system by default. Follow the user's
supplied reference or explicit direction. For a small change, match the surrounding
interface and check affected states without inventing a new product identity.

For a new screen or substantial redesign, use the `design-system` skill to resolve the
token source: the existing system, or one kit for a new system. Read a supplied
reference before claiming to follow it. If it cannot be accessed, state that
limitation and distinguish assumptions from observations.

## Write a useful brief

Record decisions in `.design/brief.md`. Design Studio includes a bounded excerpt
in subsequent UI requests; keep critical decisions at the top. This directory is
local and self-ignored once Design Studio persists a kit. Put decisions the team
must share in its normal tracked design docs too.

Use only the fields that affect this task:

```markdown
# Design brief — <product / surface>
Audience and primary task: <who needs to do what, under which constraints>
System and scope: <existing tokens/components or selected kit; what is changing>
Content priority: <primary action, essential information, supporting evidence>
Direction: <visual idea tied to this product, and why it supports the task>
References: <inspected artifact / URL / local file and the specific lesson>
Layout and type: <reading order, density, grid, type roles and prose measure>
Color and assets: <semantic roles, actual imagery/data, asset sources>
States and adaptation: <mobile/short viewports, themes, key edge cases>
Avoid: <specific failure modes for this product>
Acceptance: <observable checks, not adjectives such as premium or clean>
Assumptions: <unknown content, data or constraints; clearly labelled>
```

Do not fabricate three famous references to fill a template. When the prompt is
sufficient, state the direction briefly and continue. Ask only when a missing fact
changes the product outcome; otherwise use a reversible assumption.

For an open-ended new identity, compare a few directions briefly before choosing
one. Distinguish them by layout, content emphasis, typography or interaction,
not just palette. Explain why the selected direction fits. When the user asks
to choose, present real alternatives; otherwise continue with the best fit.
Style vocabulary and kit mappings: load `references/directions.md` with `skill`.

## Make originality come from the product

Start with its distinctive content or workflow. A dispatch screen can prioritize
exceptions and arrival windows; an archive can use dates, captions and source
material; a field tool can make offline state and recovery unmistakable. These
decisions create identity without decorative tricks.

- **Content first:** use representative real text, realistic lengths and useful
  data. Label demo data. Never invent customer logos, testimonials, usage counts,
  awards or conversion claims as evidence.
- **Composition:** choose hierarchy from reading order and action. Tables,
  repeated rows and equal product cards often need consistency. Vary layout
  when content roles differ, not to satisfy an asymmetry quota.
- **Typography:** decide display, text, label and numeric roles. A single family
  can be excellent. Use loaded/licensed fonts available to the project, test
  fallback and wrapping, and control prose measure without applying it to tables.
- **Color:** assign semantic roles and protect the primary action's salience.
  60/30/10 is a possible starting point, not an acceptance rule. Links, data
  categories and status indicators may need many accent uses.
- **Surfaces:** grouping must mean something. Use spacing, borders, radii and
  elevation by role; a border plus shadow can improve separation. Do not wrap
  every paragraph in a card.
- **Assets:** choose imagery that explains the product or establishes its tone.
  Use available assets or appropriate generation/search tooling when needed;
  inspect the actual asset, crop, resolution, rights and contrast. Do not fill
  space with unrelated stock illustrations or present a mockup as a real screenshot.
- **Distinctiveness:** express a coherent idea where it helps. A quiet form does
  not need a signature gimmick; a brand surface may carry a stronger motif.
- **Motion:** explain a state change or spatial relationship; respect reduced
  motion and keep controls usable without animation.

Use `skill({ name: "design-craft", resource: "references/<file>.md" })` as needed:
`composition`, `typography`, `color`, `copy`, `slop-inventory`. These references
are diagnostic aids; user intent, accessibility and product context outrank
stylistic recipes. A pattern alone is not proof of low quality.

## Build, inspect, correct

1. Establish structure with representative content, then type and spacing,
   then color, assets and motion. Preserve semantic markup and working controls.
2. Exercise the main task, keyboard flow and reachable loading, empty, error,
   success, disabled and overflow states. Avoid decorative controls that do nothing.
3. Inspect the actual rendered surface. Test the relevant desktop size, a narrow
   viewport and a short viewport where dialogs/toolbars may hide actions. Include
   supported themes, long labels and realistic content volume. For mobile changes,
   check touch affordances and scrolling; for native stacks use device evidence.
4. Run the `design` tool with `{action:"verify"}` when a kit is pinned. Review findings against
   the brief and token source. Fix drift; retain justified design choices. Zero
   findings and a 100% palette score do not establish quality or accessibility.
5. Use the `design-critique` skill to identify the highest-impact visible problems. Fix
   them within the authorized scope, then inspect the affected screens again.
   Stop when acceptance checks are met, not after arbitrary cosmetic churn.

Make rendered checks concrete:

- **Hierarchy:** can the main task and content priority be identified quickly?
- **Product swap:** would changing only the logo leave an equally plausible
  unrelated product? If so, improve domain content or workflow, not decoration.
- **Constraint stress:** does the primary action remain reachable with a short
  viewport, long text, keyboard focus and supported content extremes?
- **Reference fidelity:** compare geometry, type, spacing, imagery and colors
  literally when matching a reference; explain deliberate deviations.

If rendering tools are unavailable, inspect source and state precisely what
remains unverified. Do not claim screenshot, contrast, responsive or interaction
checks that were not performed. Native theme constants and dynamically generated
classes are outside much of the source scanner's coverage.

## Handoff

Give the direction and its product rationale, implementation outcome, observed
checks with viewport/state or artifact evidence, and material unknowns. For
substantial work, keep this concise record in `.design/review.md` so a later
turn can distinguish inspected behavior from pending checks. Keep speculative
improvements separate from defects; a prompt or scanner cannot guarantee originality.

## Content and interaction fidelity

Connect the visual direction to the actual domain workflow and content density.
Check real long strings, localized copy, formatted numbers and supported reduced
motion/forced colors. Verify controls from entry to completion, including recovery
from failed or duplicate submission. Record artifact/route and rendered state
before claiming fidelity to a reference; source tokens alone do not establish it.

## Acceptance checks

- Inspect actual rendered widths and states; exercise interactions, keyboard focus and recovery.
