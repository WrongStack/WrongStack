---
name: data-governance
description: |
  Use this skill when designing or reviewing data governance: schema ownership,
  PII handling, retention, lineage, access policy, and migration safety for
  services and data stores.
  Triggers: user says "data governance", "PII", "schema ownership", "retention policy", "data lineage", "migration safety".
trigger: "Use this skill when designing or reviewing data governance: schema ownership, PII handling, retention, lineage, access policy, and migration safety for services and data stores."
version: 1.2.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [code.inspect]
metadata:
  routing-group: data
---

# Data Governance

Designs and reviews data governance for services and data stores: schema ownership, PII handling, retention, lineage, access policy, and migration safety.

## Selection card
- Task: Define data ownership, retention and PII boundaries.
- Start: Identify the data owner, query/schema, consistency and recovery contract.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Establishes who owns each data entity, how sensitive fields are classified and protected, how long data is retained, and how schema changes ship without losing or leaking data. Produces concrete policy plus code-level guardrails, not prose.

## Rules

1. Every persisted entity has an accountable owner. Respect existing service/module boundaries and documented shared-store contracts.
2. Classify every field: public, internal, sensitive, or restricted (PII/credentials). Restricted fields are encrypted at rest and redacted in logs.
3. Never log or echo restricted fields — redact at the serialization boundary, not at each call site.
4. Every schema change ships with a forward migration and a tested recovery plan; destructive drops are two-phase (deprecate → drop) across releases.
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

## Boundaries

Keep retention, access and recovery rules proportional to the actual data and
applicable product policies. Do not force a new service architecture or claim
that a destructive schema rollback can recover dropped information. Centralize
redaction and verify its reach across logs, exports and derived storage.

## Before returning

- [ ] Every persisted entity has an accountable owner and documented access boundaries
- [ ] Every field classified as public / internal / sensitive / restricted
- [ ] Restricted fields protected at rest according to policy; redacted at the serialization boundary
- [ ] No restricted fields in logs, errors, or stack traces
- [ ] Schema changes have forward migration + tested recovery/rollback where reversible
- [ ] Destructive changes are two-phase: deprecate → drop across releases
- [ ] Retention TTL/purge cadence explicit per entity; right-to-erase path verifiable
- [ ] Derived data records source columns/versions; lineage queryable
- [ ] Dry-run run on the migration before Phase 2 ships
- [ ] `<nextsteps>` lists each open migration, classification gap, or retention fix

## Recovery and deletion semantics

Define an accountable owner per entity without forcing a microservice architecture
onto a monolith. Map sensitive fields through caches, exports, replicas, backups
and derived data, and state deletion/retention exceptions explicitly.
Do not claim a destructive migration is reversible when dropped data needs restore.
Use the database engine's actual DDL/locking rules and test forward repair or
restoration. Record the recovered data boundary and last verified restore.

## Skills in scope

- `security-scanner` — for encryption-at-rest, secret handling, and access-control review
- `audit-log` — for verifying restricted-access audit trails and retention evidence
- `api-design` — for owning-service API boundaries instead of shared tables
- `testing` — for redaction, purge-path, and migration tests
