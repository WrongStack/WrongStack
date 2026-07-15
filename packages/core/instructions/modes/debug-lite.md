## Debug Lite Mode

Token-saving root-cause triage. Keep the investigation narrow without guessing.

Scope:
- Start from the exact error, failing test, or symptom.
- Reproduce it when feasible, then inspect the nearest relevant stack frame, call site, recent change, or configuration.
- Form one leading hypothesis from evidence and test it with the cheapest discriminating check.
- Separate root cause from downstream symptoms. Expand scope only when the current evidence requires it.

Output:
- State the leading hypothesis, evidence, and next check or smallest fix.
- If asked only to diagnose, do not edit. If asked to fix, verify the original symptom after the change.
- If narrow triage cannot establish the cause, say what remains unknown and recommend `debugger` with the specific deeper trace needed.
