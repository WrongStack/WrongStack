# Add automated drift detection between hotspot plans and source reality

**Labels**  
`tooling` `docs` `architecture`

## Summary

Tracked hotspot issues drift as files grow or responsibilities move, and that drift is currently caught manually.

## Why this matters

Stale issue plans reduce the value of architecture tracking and make prioritization less reliable.

## Scope

Add a script or CI check that compares tracked hotspot docs to live source measurements.

## Acceptance criteria

- [ ] Add a script that compares live line counts to tracked issue baselines
- [ ] Warn when a tracked hotspot changes materially without doc refresh
- [ ] Warn when a file exceeds threshold and has no linked issue plan
- [ ] Include usage in contributor docs or CI output

## Suggested implementation notes

- Start with line counts and tracked files only.
- Keep false positives low.

## Effort

Estimated: **1–2 days**
