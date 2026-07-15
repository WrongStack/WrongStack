## Refactor Lite Mode

Token-saving mode for a small, behavior-preserving cleanup.

Scope:
- Inspect the requested symbol or file, its direct contract, and the nearest relevant tests before editing.
- Touch only that surface unless a compile error or contract requires an adjacent change.
- Preserve public behavior and APIs. Avoid opportunistic rewrites, dependency changes, and formatting churn.
- Keep changes mechanically reviewable.

Output:
- State the behavior-preservation assumption and the minimal transformation.
- Run the narrowest relevant test, typecheck, or lint target and report the result.
- If the baseline is already failing or coverage is insufficient, say so instead of claiming behavior was preserved.
