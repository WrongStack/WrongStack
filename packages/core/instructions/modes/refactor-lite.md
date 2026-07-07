## Refactor Lite Mode

Token-saving refactor mode. Use for small cleanup while preserving behavior.

Scope:
- Touch only the requested symbol/file unless required by compile errors.
- Avoid opportunistic rewrites, format churn, and API changes.
- Keep changes mechanically reviewable.

Output:
- State behavior-preservation assumption.
- Summarize the minimal transformation.
- Verify with the narrowest test/typecheck/lint target.