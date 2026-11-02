---
name: storage-uploads
description: "File uploads and object storage on S3, R2, GCS or MinIO: presigned URLs, multipart, checksums, content-type safety, lifecycle. Use when building attachment or avatar uploads, direct-to-bucket uploads, signed downloads, image processing, or bucket CORS and lifecycle rules, or upgrading the AWS SDK. Not for database backups (use backup-recovery) or retention and erasure policy (use data-governance)."
trigger: "Use when code presigns URLs, calls PutObject, GetObject or multipart APIs, accepts multipart/form-data files, or configures bucket CORS or lifecycle."
version: 1.1.2
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: data
  domain: "data"
---

# Storage Uploads

## Selection card
- Task: Build or repair upload and download flows where database records and bucket objects stay consistent and safe to serve.
- Start: Read the storage client setup (SDK version, endpoint, region, checksum settings), bucket policy, CORS and lifecycle config, and the upload record model.
- Finish: a real upload goes pending → verified → active against a local or dev bucket, wrong type, size, expiry and cross-tenant access are refused, and abandoned uploads get cleaned up.

## Overview

An upload is a two-party transaction between your database and a bucket that never commit together, so every flow needs a pending state, server-side verification and a sweeper.
Checked AWS S3 JavaScript SDK target: 3.1161.0 on 2026-10-23. Verify provider-specific API/binding support; S3-compatible does not mean every operation or signature setting is identical.
Since early 2025 the v3 SDK adds CRC checksums to uploads by default (`requestChecksumCalculation: "WHEN_SUPPORTED"`), which breaks some S3-compatible stores and presigned-URL clients until set to `"WHEN_REQUIRED"`.

## Rules

1. Object keys are server-generated (`<tenant>/<kind>/<uuid>`). The user's filename is display metadata only: sanitized, length-limited, never part of a key or filesystem path.
2. Model `pending → uploaded → verified → active` (plus `rejected` and `deleted`). Create the row before issuing the URL; only a server-side check (`HeadObject` size, type and checksum, plus scanning where required) promotes it.
3. Presign narrowly: one key, one method, minutes of validity, Content-Type signed. Size ranges need a presigned POST policy with `content-length-range`; a presigned PUT can only pin an exact `Content-Length`. URLs signed with temporary credentials die when those credentials expire.
4. Never trust the client's Content-Type, extension or `file.type`; sniff magic bytes for security-relevant types and re-encode images rather than serving originals.
5. Serve user content safely: a separate cookieless domain or `Content-Disposition: attachment` for anything renderable (HTML, SVG, XML, PDF), `X-Content-Type-Options: nosniff`, and RFC 6266 `filename*=UTF-8''...` encoding with CR and LF stripped.
6. Buckets stay private with Block Public Access on and ACLs disabled (new S3 buckets enforce bucket-owner ownership, so `ACL: 'public-read'` fails); public delivery goes through a CDN with origin access control or short signed GETs.
7. Stream large transfers (`Upload` from `@aws-sdk/lib-storage`, streaming multipart parsers with limits); never buffer whole files in memory (multer memory storage, `req.arrayBuffer()` on big bodies).
8. Lifecycle owns cleanup: an `AbortIncompleteMultipartUpload` rule, expiry on pending prefixes, and a sweeper that reconciles rows and objects in both directions.

## First moves by situation

| Situation | First moves |
|---|---|
| New upload feature | Direct-to-bucket presigned upload for large files or serverless limits; proxy through the API only for small files that need inline checks; then a completion endpoint that verifies with `HeadObject` |
| Presigned PUT fails with SignatureDoesNotMatch | Sent Content-Type differs from the signed one; newer SDKs embed checksum parameters (`x-amz-checksum-*`, `x-amz-sdk-checksum-algorithm`) the browser never sends; clock skew; region, endpoint or path-style mismatch |
| Browser upload blocked by CORS | Bucket CORS with exact `AllowedOrigins`, `PUT`/`POST` methods, `content-type` in `AllowedHeaders`, and `ExposeHeaders: ["ETag"]` for multipart |
| S3-compatible store errors after an SDK upgrade | Set `requestChecksumCalculation` and `responseChecksumValidation` to `"WHEN_REQUIRED"`; R2 uses `region: "auto"` and the account endpoint; confirm the provider supports each operation used (presigned POST policies are not universal) |
| Large or resumable uploads | Multipart: parts of at least 5 MiB except the last, at most 10,000 parts, presign each part, complete with ordered part numbers and ETags; or a resumable protocol such as tus |
| Request body too large on serverless | Vercel functions cap request bodies around 4.5 MB and Next.js Server Actions default to 1 MB (`serverActions.bodySizeLimit`); move to direct-to-bucket uploads |
| Image uploads | Decode with pixel limits against decompression bombs, strip EXIF (GPS), re-encode to a fixed format, and do it in a worker rather than the request |
| Security review | Key generation, presign scope and expiry, type handling, serving domain and headers, bucket policy and public access block, per-tenant authorization before every signed GET |

## Patterns and pitfalls

- **ETag is not MD5** — multipart and SSE-KMS objects have ETags that are not content hashes; verify integrity with `x-amz-checksum-sha256` or CRC checksums.
- **HeadObject 403 versus 404** — without `s3:ListBucket`, a missing object returns 403; completion checks misreport an unfinished upload as a permission error.
- **Overwrite races** — two writers to one key means last write wins; use unique keys, or conditional writes (`If-None-Match: *`) to refuse overwriting.
- **Event notifications** — S3 events are at-least-once and unordered; process idempotently keyed by object key plus version or the event `sequencer`.
- **CDN staleness** — S3 itself is read-after-write consistent, but CDNs and some compatible stores cache; replace content under a new versioned key instead of overwriting.
- **Signed URLs are bearer tokens** — they leak through logs, browser history and `Referer`; keep expiry short and authorize the caller every time one is minted.
- **Download overrides** — `ResponseContentDisposition` and `ResponseContentType` on a signed GET force download and fix the filename without rewriting the object.
- **Invisible multipart cost** — incomplete multipart uploads are billed but hidden from normal listings; check with `list-multipart-uploads`.
- **Versioned erasure** — in versioned buckets a delete only adds a delete marker; erasure needs version deletes or `NoncurrentVersionExpiration`.
- **Local disk storage** — resolve the final path and verify it stays under the storage root; reject `..`, absolute paths and Windows reserved names; archives need zip-slip checks on extraction.
- **Malware and content scanning** — scan before `active`, keep unscanned objects in a quarantine prefix, and never serve from it.

## Workflow

1. Record provider, SDK version, endpoint and region, checksum settings, bucket policy, CORS, lifecycle and versioning state.
2. Define the record state machine, key layout, size and type limits, and who may read each object.
3. Write failing tests first: wrong type, oversize, expired URL, completion before upload, cross-tenant download, abandoned upload.
4. Implement presign, client upload, completion verification and safe serving; keep processing in a worker.
5. Run against MinIO, LocalStack or a dev bucket with the same provider semantics as production.
6. Report what was verified per provider; S3-compatible differences are findings, not assumptions.

## Proof

- Object check: `aws s3api head-object --bucket "$BUCKET" --key "$KEY"` (add `--endpoint-url` for S3-compatible stores) shows size, type and checksum
- Presigned PUT: `curl -fsS -X PUT -T ./fixture.png -H 'Content-Type: image/png' "$PRESIGNED_URL"` succeeds; a different Content-Type or an expired URL returns 403
- Size policy: an oversize file against a presigned POST policy is rejected with EntityTooLarge
- Bucket posture: `aws s3api get-public-access-block`, `aws s3api get-bucket-cors` and `aws s3api get-bucket-lifecycle-configuration` with `--bucket "$BUCKET"`
- Orphans: `aws s3api list-multipart-uploads --bucket "$BUCKET"` is empty after the abandoned-upload test and lifecycle window
- Serving: `curl -sI "$DOWNLOAD_URL"` shows `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` for renderable types
- Isolation: user B requesting a download URL for user A's file gets 403 or 404

## Stop and ask

- Changing bucket policy, public access block, CORS or lifecycle on a shared or production bucket.
- Deleting objects, adding expiry rules that remove existing data, or disabling versioning.
- Making any content public, or moving to a different storage provider.
- Proof needs production buckets or credentials rather than a local or dev bucket.

## Before returning

- [ ] Keys server-generated and tenant-scoped; filenames only as sanitized metadata
- [ ] Presigned URLs scoped to one key and method, short-lived, with type and size constraints observed failing
- [ ] Records promoted only after server-side `HeadObject` or checksum verification
- [ ] Renderable user content served as attachment or from an isolated domain, with `nosniff`
- [ ] Buckets private; cross-tenant download refused
- [ ] Large transfers streamed; abandoned multipart uploads and pending rows cleaned up

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[AWS S3 docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html), [Cloudflare R2](https://developers.cloudflare.com/r2/), [S3 data integrity](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html), [RFC 6266](https://www.rfc-editor.org/rfc/rfc6266).

## Skills in scope

- api-design — upload initiation and completion endpoints, streaming responses and error contracts.
- data-governance — attachment retention windows, encryption at rest and erasure cascades.
- database-development — upload record state transitions and reconciliation queries.
- backup-recovery — backups and restoration for buckets and their metadata.
- queues-jobs — scanning and image processing as at-least-once background work.
- cloudflare-workers — R2 bindings and Worker-side upload handling.
