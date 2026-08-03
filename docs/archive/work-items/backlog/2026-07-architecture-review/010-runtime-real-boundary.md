# Make `@wrongstack/runtime` a real package boundary

**Labels**  
`architecture` `refactor` `runtime` `core` `tech-debt`

## Summary

`@wrongstack/runtime` is still transitional and mostly re-exports from `@wrongstack/core`, so the intended boundary exists more in docs than in code.

## Why this matters

As long as concrete defaults live in `core`, package layering is harder to enforce and architectural direction stays blurry.

## Scope

Move concrete runtime implementations physically into `@wrongstack/runtime` and reduce facade-only re-exports.

## Acceptance criteria

- [ ] Identify concrete defaults currently living in `core` that belong in `runtime`
- [ ] Move at least one complete subsystem physically from `core` to `runtime`
- [ ] Reduce re-export-only surface in `packages/runtime/src/index.ts`
- [ ] Update imports in at least one consumer package
- [ ] Add/refresh architecture docs describing the new boundary

## Suggested implementation notes

- Start with a cohesive subsystem, not scattered one-off moves.
- Preserve public API compatibility where possible.

## Effort

Estimated: **4–7 days**
