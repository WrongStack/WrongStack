# /design — Design Studio

Browse and pin a **curated UI design kit** for the current session. Design Studio
gives the model selectable, production-grade design directions (aesthetic + concrete
OKLCH tokens + per-stack guidance) instead of leaving UI styling to chance.

## How it works

Design Studio activates automatically when the model is building a UI:

1. **Detection** — a per-turn middleware watches your messages (e.g. "build a landing
   page", "a Flutter screen") and frontend file writes (`.tsx`, `.css`, `.dart`,
   `.swift`, …) and flags the session as doing UI work, inferring the target stack.
2. **Menu injection** — while no kit is chosen, every request carries a compact menu of
   kits plus the non-negotiable baseline (responsive, light/dark, WCAG AA, motion).
3. **Load on demand** — the model calls the `design` tool (`list` → `use <kit> --stack
   <stack>`) to pull the full, stack-specific spec into context, then implements it.
   Once a kit is active, the per-turn block shrinks to a one-line adherence reminder.

`/design` is the manual control over that flow.

## Usage

```
/design                     List available kits and the active one
/design <kit-id> [stack]    Pin a kit and load its full spec next turn
/design off                 Clear the active kit (detection stays on)
/design foundations         Print the mandatory baseline (responsive/a11y/theming/motion)
```

Stacks: `web` · `react-native` · `flutter` · `swiftui` · `compose`.

### Examples

```
/design                     # see the menu
/design minimal-clarity web
/design neo-brutalist
/design off
```

## Bundled kits

`minimal-clarity`, `soft-glass`, `neo-brutalist`, `editorial`, `bento-dashboard`,
`dopamine-pop`, `aurora-gradient`, `corporate-trust`, `playful-rounded`, `dark-pro`,
`ios-native`, `material-expressive`.

## Adding your own kits

Drop a kit folder next to the bundled ones — discovery order (first wins):

1. `<project>/.wrongstack/design-kits/<id>/` (committed, shared with your team)
2. `~/.wrongstack/design-kits/<id>/` (user-global)
3. bundled (`@wrongstack/core/design-kits/`)

Each kit folder contains:

- `KIT.md` — YAML frontmatter (`id`, `name`, `aesthetic`, `tags`, `stacks`, `themes`,
  `bestFor`) + the design spec body. Stack-specific guidance lives under
  `## Stack: <stack-id>` headings (narrowed when a stack is requested).
- `tokens.json` — `{ "light": {…}, "dark": {…} }` OKLCH token snapshots (also used by
  the WebUI/TUI visual pickers).

The reserved id `_foundations` holds the mandatory baseline and is excluded from the menu.

## Project-local decisions & rules — `.design/`

Separate from the committed `.wrongstack/design-kits/` (shared custom kits), a
**gitignored** `<project>/.design/` directory holds your project-local design
state. It self-ignores (a `.design/.gitignore` of `*` is written on first use),
so it stays out of the repo in any project.

| File | Purpose |
|---|---|
| `.design/rules.md` | Project design rules. Injected into every UI turn and **override kit defaults on conflict** (e.g. brand colors, spacing system, banned patterns). Create it yourself. |
| `.design/active.json` | The pinned kit (`{ kit, stack }`). Written when you pick a kit; **restored on the next session** so a design direction persists. |
| `.design/decisions.md` | Append-only log of kit choices: `- <iso> · kit=… stack=… via=tool\|webui\|slash`. |

Picking a kit (via the `design` tool, `/design <kit>`, or the WebUI panel)
records the choice; `/design off` clears the pin (the decision log is kept).
