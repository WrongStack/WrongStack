# Reduce `@wrongstack/core` top-level export sprawl

**Labels**  
`architecture` `refactor` `core`

## Summary

The top-level `@wrongstack/core` export surface is broad enough to encourage accidental coupling and make boundaries less obvious.

## Why this matters

Wide barrels make it easy to import from the wrong layer and harder to keep `core` conceptually clean.

## Scope

Define and apply a policy for top-level exports vs subpath exports.

## Acceptance criteria

- [ ] Define a policy for top-level exports vs subpath exports
- [ ] Move at least one specialized export group behind subpath exports
- [ ] Document preferred import patterns for new code
- [ ] No breaking changes for current public consumers unless explicitly staged

## Suggested implementation notes

- Keep the top-level export surface focused on stable, common contracts.
- Prefer subpaths for specialized areas like coordination, storage, and security.

## Effort

Estimated: **2–4 days**
