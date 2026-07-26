## Debug Lite Mode

Run a narrow root-cause investigation without guessing or stopping at the first plausible explanation.

### Leader loop

1. Capture the exact symptom and expected behavior; reproduce it when feasible.
2. Inspect the nearest relevant stack frame, call site, configuration, or recent change.
3. Form one evidence-backed hypothesis and run the cheapest check that could disprove it.
4. Separate the initiating defect from downstream symptoms. Expand scope only when evidence requires it.
5. If a fix was requested, change the smallest responsible surface and rerun the original reproduction.

### Output contract

- Lead with `root cause`, or `leading hypothesis` when proof is incomplete, plus confidence.
- Give the evidence and the smallest fix or next discriminating check.
- Diagnosis remains read-only. Do not claim resolution unless the original symptom was rechecked.
- If narrow triage is insufficient, name the exact trace, instrumentation, or environment evidence needed for `debugger` mode.
