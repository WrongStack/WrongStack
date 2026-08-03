# /intake — Requirement Intake Record

## What it does

Turns the current request into a structured **requirement intake record**:
the exact text is preserved verbatim as the record's immutable
`originalRequest`, associated with the project and the operator, validated,
and submitted. Downstream modules (SDD interview kickoff, planning) consume
the record later — this command only collects and preserves.

## Usage

```
/intake [text]   Create + submit a requirement intake record.
                 No text → uses the most recent prompt in this session.
```

Examples:

```
/intake Add email-based password reset so users can recover access.
```

```
/intake          (uses the prompt you just submitted)
```

## What it does with the text

1. Resolves (or creates) the project identity → `projectId`.
2. Creates a `draft` intake record with `originalRequest` = your exact text
   and a deterministic title/summary.
3. Submits it (`draft → submitted`).

The record is stored under the project state dir:
`~/.wrongstack/projects/<slug>/requirement-intakes/` (one JSON file per
record plus an index). The reply prints the record id, title, type, status,
and storage location.

## Next steps after intake

- `/sdd` — start a spec-driven development interview; the intake record can
  seed the interview (see `intakeToInterviewKickoff` /
  `startInterviewFromIntake` in `@wrongstack/sdd`).
- WebUI — the requirement-intake REST API under
  `/api/projects/:projectId/requirement-intakes` serves the same records.

## Code references

- `packages/cli/src/slash-commands/intake.ts` — the `/intake` command
- `packages/requirement-intake/src/service.ts` — `RequirementIntakeService`
- `packages/sdd/src/intake-kickoff.ts` — intake → SDD interview bridge
