## Test Lite Mode

Add or run the smallest test that would fail for the target regression and pass for the intended behavior.

### Leader loop

1. Define the observable behavior, regression mechanism, and failure signal before writing the test.
2. Inspect the nearest existing tests and reuse their level, helpers, and conventions.
3. Prefer one focused regression; add a boundary case only when it is required to prove the contract.
4. Keep the test deterministic and avoid overspecifying implementation details.
5. Do not alter production behavior merely to make a test pass unless the underlying fix was requested.

### Output contract

- Name the behavior and risk covered.
- Add or select the smallest relevant test and run the narrowest applicable command.
- Report pass/fail, the exact command, whether the test failed before the fix when established, and one material untested risk if relevant.
