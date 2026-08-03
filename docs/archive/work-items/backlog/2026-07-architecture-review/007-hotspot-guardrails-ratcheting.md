# Convert hotspot guardrails from advisory to ratcheting enforcement

**Labels**  
`engineering-quality` `architecture` `tech-debt`

## Summary

Hotspot controls exist, but they mostly document debt. They do not strongly prevent further growth of known large files.

## Why this matters

Without ratcheting enforcement, hotspot files can continue growing while the repo still “passes” its architectural checks.

## Scope

Upgrade hotspot guardrails so known large files cannot grow without explicit baseline updates.

## Acceptance criteria

- [ ] `scripts/check-file-size.mjs` supports ratcheting mode
- [ ] Known hotspot files cannot grow without an explicit baseline update
- [ ] CI fails on hotspot growth in protected files
- [ ] Existing “temporary debt baseline” behavior remains documented

## Suggested implementation notes

- Keep room for intentional exceptions, but require explicit review.
- Prefer “no-growth” checks before introducing hard global caps.

## Effort

Estimated: **1–2 days**
