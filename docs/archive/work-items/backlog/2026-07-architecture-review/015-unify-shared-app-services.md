# Unify shared app-service flows across CLI, TUI, and WebUI

**Labels**  
`architecture` `refactor` `cli` `tui` `webui`

## Summary

Session, mode, provider/model, and coordination flows are conceptually shared but are wired differently across user-facing surfaces.

## Why this matters

Duplicated or diverging flow logic raises maintenance cost and makes behavior less consistent between interfaces.

## Scope

Extract a shared app-service layer for one or more common flows and reuse it across at least two surfaces.

## Acceptance criteria

- [ ] Identify one shared flow and extract a common service layer
- [ ] Reuse the service from at least 2 surfaces
- [ ] Remove duplicated logic in at least one UI bridge
- [ ] Document ownership of shared app-service modules

## Suggested implementation notes

- Start with a flow that already exists in multiple surfaces, such as:
  - session lifecycle
  - model/provider switching
  - mode switching
- Avoid over-generalizing too early.

## Effort

Estimated: **5–8 days**
