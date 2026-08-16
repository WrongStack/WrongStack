---
name: <skill-name>
description: |
  <One-sentence trigger — what situation activates this skill.>
  Triggers: user says "<keyword>", "<keyword>", "<keyword>".
version: 2.0.0
required-capabilities: [<list>]
required-tools: [<list>]
optional-capabilities: [<list>]
---

# <Skill Title> — WrongStack

## Overview

<What this skill does, in two or three sentences. State the deliverable shape.>

## Rules

<Numbered, testable, non-overlapping. Each rule is something a model can
verify it followed. Avoid prose. If a rule has exceptions, say so explicitly.>

## Out of scope

<The opposite of the Overview. List explicitly what this skill does NOT
do, and where the work should go instead. This is the in-lane guardrail:
a model reading the skill should know when to stop and hand off.

Format: bullet list of "DON'T do X — that's the `<other-skill>` skill" or
"DON'T do X — it's not the model agent's job to Y at all." Be specific.>

## Skills in scope

<Adjacent skills for delegation. One line each, naming the reason the
adjacent skill is the right next step. This is the model-to-model
hand-off list — when a related question arrives, the skill body says
where to send it.>

## Patterns

### Do

```typescript
// ✅ Correct pattern for this skill's domain.
```

### Don't

```typescript
// ❌ Anti-pattern: common mistake inside this skill's lane.
```

## Anti-patterns

- **<named anti-pattern>** — <what it looks like, why it's wrong, what to do instead>
- ...

## Before returning

<The in-lane enforcement checklist. The model runs through this before
delivering its output. Any unchecked item is a reason to keep working.

Format: a short numbered list of mechanical checks. Each item is something
the model can answer yes/no about its own work.>

- [ ] <check 1>
- [ ] <check 2>
- [ ] ...

---

## Authoring rules (for skill-creator)

1. **First sentence of `description` = trigger.** The skill loader matches on it.
2. **Name in kebab-case.** Lowercase, hyphens only, no collisions with existing skills.
3. **Out of scope is mandatory.** A skill without explicit "what this is NOT" cannot
   enforce in-lane behavior. State the boundaries and the hand-offs.
4. **Before returning is mandatory.** A model needs a mechanical checklist to verify
   it stayed in lane. State what completion looks like in checkable form.
5. **Rules are testable.** "Be careful with X" is not a rule. "Always do Y before Z"
   is. If a model cannot tell whether it followed a rule, the rule is decorative.
6. **Anti-patterns name a specific failure mode.** Not "avoid mistakes" — name the
   mistake, the symptom, the fix.
7. **Skills in scope names the hand-off.** When a related question arrives, the body
   points at the next skill. No "see also" — name the reason.
8. **End with a version.** Bump on structural changes (new section, scope change,
   rule change). Patch for wording fixes. Document the bump in CHANGELOG.md.
