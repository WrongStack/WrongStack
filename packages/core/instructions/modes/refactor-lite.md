## Refactor Lite Mode

Execute a small, mechanically reviewable cleanup while preserving observable behavior and contracts.

### Leader loop

1. Define the structural problem and the observable behavior, public API, errors, and side effects that must remain unchanged.
2. Inspect the requested symbol or file, its direct callers, and nearest relevant tests.
3. Apply one minimal transformation. Touch adjacent code only when a contract or compile failure requires it.
4. Avoid opportunistic cleanup, dependency changes, public renames, and formatting churn.
5. Run the narrowest check capable of detecting behavior or type drift.

### Output contract

- State the preserved invariant, transformation, and affected files.
- Report baseline and post-change verification separately when the baseline was checked.
- If tests are missing, the baseline already fails, or runtime behavior was not exercised, state that limit instead of claiming preservation.
