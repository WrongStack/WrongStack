---
name: python-backend
description: "Build and upgrade Python services with explicit environments, validation, async boundaries and resource cleanup. Use when working on FastAPI, Django or Python API/jobs; preserve the project framework and packaging workflow."
trigger: "Build and upgrade Python services with explicit environments, validation, async boundaries and resource cleanup. Use when working on FastAPI, Django or Python API/jobs; preserve the project framework and packaging workflow."
version: 1.0.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "backend"
---

# Python Backend

## Selection card
- Task: Implement Python APIs and typed validation.
- Start: Locate the endpoint, schema, authentication boundary and caller.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Build and upgrade Python services with explicit environments, validation, async boundaries and resource cleanup.

Checked 2026-10-09: Python 3.15.0, FastAPI 0.143.0, Django 6.1.2 and uv 0.12.24. Verify framework/native-wheel/Python support before combining them; latest Python can lead package support.

## Rules

1. Inspect pyproject/lockfile, interpreter, environment and deployment entrypoint.
2. Validate incoming data and model output contracts; static annotations do not validate JSON.
3. Keep blocking I/O and CPU work off async request loops; cancellation must propagate to owned work.
4. Scope database sessions/clients and transactions to the operation; cleanup must run on failure.
5. Keep secrets/config and public serialization explicit; object authorization remains at the data operation.
6. Do not replace the project package manager or migrate frameworks as an incidental feature change.

## Workflow

1. Trace the request/job path and current framework/environment conventions.
2. Verify latest stable targets and support requirements; read migration notes.
3. Implement the feature with typed/validated boundaries and explicit resource ownership.
4. Test input/errors, database rollback, cancellation and application startup.
5. Run configured formatting/lint/type/tests and the real service entrypoint.

## Before returning

Interpreter/environment and compatibility clear; validation/async/resource semantics tested; framework/service checks reported.

## Sources

Versioned facts checked 2026-10-09; refresh authoritative sources before new installs/upgrades.
[Python releases](https://www.python.org/downloads/), [FastAPI](https://fastapi.tiangolo.com/), [Django](https://docs.djangoproject.com/en/stable/).

## Skills in scope

- api-design — api design contracts and verification.
- database-development — implement database access, models and queries with explicit consistency, transactions and bounded results.
- queues-jobs — implement reliable asynchronous jobs and message consumers with explicit delivery, retry and shutdown semantics.
- testing — testing contracts and verification.
