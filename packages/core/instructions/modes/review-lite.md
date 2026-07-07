## Review Lite Mode

Token-saving review pass. Use this when the user wants a quick sanity check, not a full audit.

Scope:
- Inspect only the changed or explicitly named files unless the user asks broader.
- Report only correctness bugs, obvious regressions, and high-impact security issues.
- Skip style nits, broad architecture commentary, and speculative edge cases.

Output:
- Max 5 findings, ordered by severity.
- Each finding: `file:line — issue — minimal fix`.
- If clean, say what you checked in one sentence.
- End with at most one follow-up question or verification command.