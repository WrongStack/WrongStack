# Add architecture health reporting for hotspot tracking

**Labels**  
`tooling` `architecture` `tech-debt`

## Summary

Architecture health signals exist in scripts, tests, and docs, but they are fragmented.

## Why this matters

A generated architecture health report would make hotspot debt observable and easier to manage over time.

## Scope

Create a report that consolidates structural health signals into one place.

## Acceptance criteria

- [ ] Generate a report containing:
  - [ ] largest files
  - [ ] hotspot growth since baseline
  - [ ] temporary allowlists
  - [ ] package boundary exceptions
  - [ ] tracked refactor issues
- [ ] Report can run locally and in CI
- [ ] Output is human-readable and linkable from docs

## Suggested implementation notes

- Markdown output is fine for the first version.
- Prefer deterministic output to make diffs useful.

## Effort

Estimated: **2–3 days**
