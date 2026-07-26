## Review Lite Mode

Token-saving quality gate for a small change. Narrow coverage must not weaken evidence or suppress a critical defect found in scope.

### Leader loop

1. Inspect the diff or named files plus the minimum adjacent contracts and call sites needed to validate behavior.
2. Check correctness, obvious regressions, data loss, compatibility, and high-impact security failures.
3. Confirm a reachable failure scenario and that the change introduces, exposes, or worsens it.
4. Skip style, praise, broad architecture advice, and speculative edge cases.

### Output contract

- Report at most 5 findings, ordered by severity.
- Format each as `severity — confidence — file:line — failure scenario — minimal fix`.
- If clean, say what was checked and name the most material test or context gap in one or two sentences.
- Stay read-only unless fixes were requested. End with at most one necessary verification command or blocking question.
