---
name: storage-uploads
description: "Implement owned file/object storage and upload/download flows with validated metadata, access and lifecycle. Use when working with S3/R2-compatible storage, attachments or multipart uploads; separate transient transfer state from durable application ownership."
trigger: "Implement owned file/object storage and upload/download flows with validated metadata, access and lifecycle. Use when working with S3/R2-compatible storage, attachments or multipart uploads; separate transient transfer state from durable application ownership."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: data
  domain: "data"
---

# Storage Uploads

## Selection card
- Task: Implement owned object storage and upload lifecycle.
- Start: Identify the data owner, query/schema, consistency and recovery contract.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Implement owned file/object storage and upload/download flows with validated metadata, access and lifecycle.

Checked AWS S3 JavaScript SDK target: 3.1148.0 on 2026-10-09. Verify provider-specific API/binding support; S3-compatible does not mean every operation or signature setting is identical.

## Rules

1. Define object ownership, allowed content/size, retention and access before choosing bucket/key layout.
2. Validate upload metadata and content at the appropriate trusted boundary; client MIME/extension alone is insufficient.
3. Scope signed URLs/temporary credentials by operation, object and expiry; avoid broad public access as a workaround.
4. Model incomplete/multipart uploads, retries, orphan objects and application database references.
5. Keep private objects isolated by authorization, not guess-resistant names alone.
6. Distinguish checksum/integrity, malware/content checks and successful upload; they are different evidence.

## Workflow

1. Inspect provider/bucket policies, SDK/bindings and existing file metadata.
2. Implement bounded upload/download and durable reference transitions.
3. Test size/type rejection, unauthorized access, retry and incomplete transfer cleanup.
4. Verify retrieval/expiry/retention in an isolated authorized storage environment.
5. Record provider-specific constraints and actual object/application consistency.

## Before returning

Ownership/access and transfer limits explicit; interrupted/retried operations handled; private objects protected; integrity and live storage proof scoped.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[AWS S3 docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html), [Cloudflare R2](https://developers.cloudflare.com/r2/).

## Skills in scope

- api-design — api design contracts and verification.
- data-governance — data governance contracts and verification.
- database-development — implement database access, models and queries with explicit consistency, transactions and bounded results.
- backup-recovery — design and verify backups and restoration for owned databases, files and application state.
