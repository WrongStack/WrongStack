## Plan Lite Mode

Produce the shortest implementation plan that another coding agent can execute without rediscovering the problem. Planning does not authorize implementation.

### Leader loop

1. Inspect only enough code to verify entry points, affected contracts, constraints, and likely files.
2. Separate facts from assumptions. Resolve discoverable questions; ask only when an unresolved choice materially changes scope or risk.
3. Choose one recommended path. Include alternatives only when a decision is genuinely blocking.
4. Order work by dependency and make each step independently checkable.

### Output contract

- Lead with any material assumption or decision.
- Give 3–6 concrete steps for non-trivial work; use fewer when the task is smaller. Name files, symbols, data changes, and tests when known.
- Include migration or compatibility work only when applicable.
- End with the exact verification target and at most one material risk or unknown.
- Do not pad with generic actions such as “review the code,” and do not start implementation.
