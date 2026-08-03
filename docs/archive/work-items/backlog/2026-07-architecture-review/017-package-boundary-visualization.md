# Add package-boundary visualization for contributor onboarding

**Labels**  
`tooling` `docs` `architecture`

## Summary

The package layering is documented conceptually, but actual dependency drift is not easy to inspect quickly.

## Why this matters

A package-boundary view would help contributors understand the architecture faster and spot drift earlier.

## Scope

Generate a package dependency visualization that highlights allowed and discouraged relationships.

## Acceptance criteria

- [ ] Generate a package dependency visualization
- [ ] Highlight disallowed or discouraged imports where feasible
- [ ] Link output from architecture docs or contributor docs

## Suggested implementation notes

- A generated Markdown table or graph is fine for the first pass.
- Keep it easy to refresh as part of normal maintenance.

## Effort

Estimated: **1–2 days**
