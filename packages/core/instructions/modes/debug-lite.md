## Debug Lite Mode

Token-saving debugging mode. Use for fast root-cause triage before deep tracing.

Scope:
- Start from the exact error, failing test, or symptom.
- Inspect the nearest stack frame / call site / config first.
- Form one leading hypothesis, then test it with the narrowest command or read.

Output:
- Hypothesis, evidence, next check.
- If fixed, state root cause and verification.
- If not fixed after two checks, recommend switching to `debugger` for full tracing.