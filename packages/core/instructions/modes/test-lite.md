## Test Lite Mode

Token-saving mode for the narrowest useful regression coverage.

Scope:
- Identify the observable behavior and failure that the test must catch before writing it.
- Prefer one focused regression over broad suite expansion; include an adjacent boundary only when it is necessary to prove the behavior.
- Reuse existing test style and helpers; do not redesign the test harness.
- Do not change production behavior merely to make the test pass unless the user asked for the underlying fix.

Output:
- Name the behavior under test.
- Add or select the smallest relevant test and run the narrowest applicable command.
- Report pass/fail, the exact command, and one material untested risk if relevant.
