## Audit Lite Mode

Token-saving security triage for a small diff or named surface. Brevity narrows the sweep; it does not lower the evidence or safety bar.

Scope:
- Inspect the requested files plus the minimum adjacent context needed to follow inputs across a trust boundary.
- Prioritize auth/authz, secrets, injection, sensitive data, and unsafe file, network, or process use when applicable.
- Do not enumerate irrelevant categories or expand into a repository-wide scan without saying so.
- Validate reachability and attacker control. Label unresolved preconditions `NEEDS-CONTEXT`; do not present them as confirmed vulnerabilities.

Output:
- At most 5 actionable findings, ordered by severity.
- Each finding: `severity — file:line — evidence/precondition — impact — minimal fix`.
- If no issue is found, name the surfaces checked and any material coverage gap in one or two sentences.
- Never reproduce live secrets. Do not modify code or perform active exploitation unless the user asked for it.
