---
name: security-scanner
description: "Review owned source, configuration and dependency metadata for supported security findings with precise evidence and remediation. Use when assessing authorization, data exposure, unsafe boundaries, credentials or advisories; treat scanner hits as candidates and scope severity to actual reachability and impact."
version: 1.4.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [verification.run, web.research, filesystem.write]
trigger: "assessing authorization, data exposure, unsafe boundaries, credentials or advisories; treat scanner hits as candidates and scope severity to actual reachability and impact."
metadata:
  routing-group: quality
---

# Security Scanner

## Selection card
- Task: Review source trust boundaries and defensive security.
- Start: Identify the scope and obtain an executable before-proof or review evidence.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Provide a defensive, evidence-led review of the requested source and configuration.
Separate confirmed findings, supported static concerns and validation gaps.
Use local, non-destructive tests of defensive behavior where appropriate.

## Rules

1. Identify scope, assets, entrypoints and trust boundaries. Read surrounding
   validators, authorization and cleanup before interpreting a scanner hit.
2. Give every finding a real location, reachable condition, violated contract,
   impact, evidence level and concrete remediation.
3. Severity follows impact, exposure and prerequisites. TLS, CORS or HTTP patterns
   are not automatically Critical without their deployed context.
4. Redact credentials completely where possible. A test directory can contain
   real leaked credentials; distinguish known dummy fixtures from genuine values.
5. Use the ecosystem's dependency audit and exact lockfile affected ranges when
   in scope. Audit output alone does not prove exploitable runtime usage.
6. Do not contact suspected credentials/services or build attack workflows.
   Prefer source evidence and bounded tests that verify protective contracts.

## Workflow

1. Map the requested surface and preserve current dirty work.
2. Collect candidates from available scanners and focused source searches.
   Exclude dependency/build trees from generic source scanning; inspect vendored
   or generated code only when it forms the actual requested boundary.
3. Trace untrusted inputs to privileged operations and protective checks.
   Check object-level authorization, logging/redaction, resource limits and
   lifecycle ownership where applicable.
4. For dependencies, verify official advisories and affected/resolved versions.
   Distinguish direct, transitive, build-only and production use.
5. Review each candidate independently for reachability and existing protection.
   Use non-destructive local negative tests; label untested deployment assumptions.
6. Report prioritized findings and precise defensive fixes. For review-only
   requests, leave production files unchanged; apply authorized remediation
   within scope and run the affected checks.

## Remediation principles

- Validate and authorize at the operation/data boundary.
- Use parameterized data queries and structured process arguments; identifiers
  still need explicit allowlists where the API cannot parameterize them.
- Use semantic DOM/text APIs for text and maintained sanitization for authorized HTML.
- Bound filesystem access to owned roots and enforce the correct path/ownership model.
- Keep secrets out of source, logs, artifacts and error responses. Removing a
  committed credential is incomplete without the owner's rotation/revocation process.
- Apply URL/origin policies and trusted service boundaries according to real deployment.

## Report

| Severity | Location | Condition / impact | Evidence | Defensive fix |
|---|---|---|---|---|
| <level> | <file:line> | <reachable scenario> | <source/test/advisory> | <concrete change> |

Include examined scope, rejected candidates, dependency-audit availability and
missing live configuration. “No confirmed findings in this scope” is a valid
result; do not claim the application is universally secure.

## Acceptance checks

- Verify defensive findings and fixes against scoped source evidence; state unresolved claims.

## Skills in scope

- code-review — changed-contract review.
- tech-stack — affected package versions.
- data-governance — sensitive data handling.
- testing — defensive regression checks.
