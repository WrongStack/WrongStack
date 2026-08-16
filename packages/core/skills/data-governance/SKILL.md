---
name: data-governance
description: |
  Use this skill when designing or reviewing data governance: schema ownership,
  PII handling, retention, lineage, access policy, and migration safety for
  WrongStack services and stores.
  Triggers: user says "data governance", "PII", "schema ownership", "retention policy", "data lineage", "migration safety".
trigger: Use when designing or reviewing schema ownership, PII handling, retention, data lineage, access policy, or migration safety.
version: 1.1.0
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [code.inspect]
---

# Data Governance — WrongStack

Designs and reviews data governance for WrongStack services: schema ownership, PII handling, retention, lineage, access policy, and migration safety.

## Overview

Establishes who owns each data entity, how sensitive fields are classified and protected, how long data is retained, and how schema changes ship without losing or leaking data. Produces concrete policy plus code-level guardrails, not prose.

## Rules

1. Every persisted entity has exactly one owning service; cross-service access goes through that service's API, never a shared table.
2. Classify every field: public, internal, sensitive, or restricted (PII/credentials). Restricted fields are encrypted at rest and redacted in logs.
3. Never log or echo restricted fields — redact at the serialization boundary, not at each call site.
4. Every schema change ships with a forward migration AND a documented rollback; destructive drops are two-phase (deprecate → drop) across releases.
5. Retention is explicit per entity: define a TTL/purge cadence and honor deletion requests (right-to-erase) with a verifiable purge path.
6. Lineage: a field's origin and transformations are traceable; derived data records its source columns/versions.

## Patterns

### Do

```typescript
// ✅ Classify + redact at the boundary
interface UserRecord {
  id: string; // internal
  email: string; // restricted (PII) — encrypted at rest
  createdAt: string; // internal
}
function toLog(u: UserRecord) {
  return { id: u.id, email: '[redacted]', createdAt: u.createdAt };
}
```

```sql
-- ✅ Two-phase destructive change: deprecate first, drop next release
ALTER TABLE sessions ADD COLUMN legacy_data_deprecated_at timestamptz; -- phase 1
-- (next release, after backfill + verification)
-- ALTER TABLE sessions DROP COLUMN legacy_data;                       -- phase 2
```

### Don't

```typescript
// ❌ Log the whole record — leaks PII into the log stream
logger.info('user', user);

// ❌ Shared-table cross-service read — bypasses the owning service's policy
db.query('SELECT email FROM users WHERE ...'); // from a service that doesn't own users
```

## Workflow

```
1. Inventory:  List entities, owning service, and field classifications
2. Policy:     Define retention/TTL, access rules, encryption-at-rest for restricted fields
3. Guardrails: Redaction at the serialization boundary, audit log for restricted access
4. Migration:  Forward + rollback plan; destructive changes two-phase
5. Verify:     Purge-path test (right-to-erase), redaction test, migration dry-run
```

## What to look for

- **Orphaned ownership**: a table no service claims, or two services writing the same table
- **PII in logs/errors**: restricted fields appearing in log lines, stack traces, or error payloads
- **Missing retention**: data kept forever with no TTL or purge path
- **One-phase drops**: `DROP COLUMN`/`DROP TABLE` shipping without a deprecate-first phase
- **Untraceable lineage**: derived tables with no record of source columns/versions

## Anti-patterns

- **Don't redact per-call-site** — centralize at the serialization boundary or a single field will leak
- **Don't share tables across services** — it bypasses ownership and access policy
- **Don't ship destructive migrations without rollback** — every change is reversible until proven otherwise
- **Don't treat "internal" as "not sensitive"** — internal data still needs access policy and retention

## Out of scope

- **Don't log restricted fields at any call site.** Redaction lives at the serialization boundary, not at each `logger.info(user)`. A single missed redaction is a PII leak.
- **Don't share tables across services.** Cross-service reads against a table you don't own bypass the owning service's policy. Use the owning service's API.
- **Don't ship destructive migrations without a rollback plan.** One-phase drops are not policy. Deprecate → drop across releases, with a documented rollback.
- **Don't classify "internal" as "not sensitive".** Internal data still needs access policy and retention. The four classes are `public`, `internal`, `sensitive`, `restricted` — they each carry different obligations.
- **Don't design retention ad hoc.** Every persisted entity has an explicit TTL or purge cadence, and an honored right-to-erase path. "Keep forever" is not a policy.
- **Don't invent lineage in the application code.** Derived data records its source columns and versions in the schema, not in scattered comments. Lineage is queryable.
- **Don't accept "two services writing the same table" as a stopgap.** Orphaned ownership is a finding, not a workaround. Pick an owner; migrate the other side to the API.
- **Don't pass through the migration without a dry-run.** Phase 1 forward + Phase 1 rollback + verification are required before Phase 2 ships.

## Before returning

- [ ] Every persisted entity has exactly one owning service; cross-service access goes through that service's API
- [ ] Every field classified as public / internal / sensitive / restricted
- [ ] Restricted fields encrypted at rest; redacted at the serialization boundary
- [ ] No restricted fields in logs, errors, or stack traces
- [ ] Schema changes have forward migration + documented rollback
- [ ] Destructive changes are two-phase: deprecate → drop across releases
- [ ] Retention TTL/purge cadence explicit per entity; right-to-erase path verifiable
- [ ] Derived data records source columns/versions; lineage queryable
- [ ] Dry-run run on the migration before Phase 2 ships
- [ ] `<nextsteps>` lists each open migration, classification gap, or retention fix

## Skills in scope

- `security-scanner` — for encryption-at-rest, secret handling, and access-control review
- `audit-log` — for verifying restricted-access audit trails and retention evidence
- `api-design` — for owning-service API boundaries instead of shared tables
- `testing` — for redaction, purge-path, and migration tests
