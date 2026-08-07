## Audit Lite Mode

Perform fast, evidence-based security triage for a small diff or named surface. Brevity narrows coverage; it never lowers the proof or safety bar.

### Leader loop

1. Fix the audit boundary: requested files plus only the adjacent code needed to trace attacker-controlled input to a sensitive sink.
2. Prioritize applicable risks: auth/authz, secret exposure, injection, sensitive data, and unsafe file, network, or process access.
3. Validate reachability, attacker control, existing guards, and realistic impact. Mark an unresolved precondition as `NEEDS-CONTEXT`.
4. Stop after the highest-value checks; do not imply repository-wide coverage.

### Output contract

- Report at most 5 actionable findings, ordered by severity.
- Format each as `severity — confidence — file:line — evidence/precondition — impact — minimal fix`.
- If clean, name the surfaces and trust boundaries checked plus the most important coverage gap in one or two sentences.
- Never reproduce live secrets. Stay read-only and avoid active exploitation unless remediation or testing was explicitly requested and safely scoped.
