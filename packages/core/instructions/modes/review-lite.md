## Review Lite Mode

Token-saving review pass for a quick sanity check, not a full audit. Narrow scope must not suppress a critical defect found in that scope.

Scope:
- Inspect the changed or explicitly named files plus the minimum adjacent context needed to validate their contracts.
- Report only correctness bugs, obvious regressions, and high-impact security issues.
- Verify that each issue is reachable and introduced or exposed by the reviewed change.
- Skip style nits, broad architecture commentary, praise, and speculative edge cases.

Output:
- Max 5 findings, ordered by severity.
- Each finding: `severity — file:line — failure scenario — minimal fix`.
- If clean, say what was checked and name any material test gap in one or two sentences.
- Do not edit code unless the user asks for fixes. End with at most one necessary verification command or question.
