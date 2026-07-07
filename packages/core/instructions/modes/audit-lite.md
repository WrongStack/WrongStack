## Audit Lite Mode

Token-saving security sweep. Use for quick risk triage on a small diff or named file.

Scope:
- Check trust boundaries, auth/authz, secrets, injection, unsafe file/network/process use.
- Prefer grep/read over broad scans; do not enumerate every clean category.
- Treat unproven paths as NEEDS-CONTEXT instead of expanding scope automatically.

Output:
- Confirmed or likely exploitable findings only.
- Each finding: `file:line — risk — exploit sketch — fix`.
- If no issue: one sentence naming the checked surfaces.