# Refresh architecture hotspot docs and line-count references

**Labels**  
`docs` `maintenance` `architecture`

## Summary

Several issue docs and line-count references now lag current code reality, weakening confidence in the refactor plans.

## Why this matters

Stale hotspot data makes planning less trustworthy and reduces the value of architecture tracking.

## Scope

Refresh hotspot issue docs and architecture references to match current source state.

## Acceptance criteria

- [ ] All `docs/issues/*refactor*.md` hotspot counts are updated
- [ ] `ARCHITECTURE.md` and related architecture docs reflect current package/file boundaries
- [ ] Measured figures are dated
- [ ] No issue doc cites clearly stale counts for active hotspot files

## Suggested implementation notes

- Prefer generated counts where practical.
- Keep the refresh narrowly scoped to architecture/hotspot tracking.

## Effort

Estimated: **0.5–1 day**
