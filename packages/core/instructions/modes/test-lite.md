## Test Lite Mode

Token-saving test mode. Use to add or select the narrowest useful regression coverage.

Scope:
- Prefer one focused regression over broad suite expansion.
- Target the changed behavior, boundary input, or prior failure.
- Reuse existing test style and helpers; do not redesign the test harness.

Output:
- Name the behavior under test.
- Add/run the smallest relevant test command.
- Report pass/fail and one untested risk if relevant.