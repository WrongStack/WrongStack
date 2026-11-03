---
name: python-backend
description: "Python APIs and workers with FastAPI, Django, Pydantic v2, SQLAlchemy 2, Celery and uv: endpoints, validation, async I/O, sessions. Use when adding or fixing Python endpoints, models, settings or background jobs, or upgrading the Python/framework stack; preserve the project's framework and package manager. Not for language-neutral HTTP contract design (use api-design) or cross-language queue semantics (use queues-jobs)."
trigger: "Use when a request touches a Python web service or worker: pyproject.toml, uv.lock, FastAPI routers, Django apps, Pydantic models or SQLAlchemy sessions."
version: 1.1.1
required-capabilities: [filesystem.read]
required-tools: []
optional-capabilities: [filesystem.write, execution.shell, verification.run, web.research]
metadata:
  routing-group: backend
  domain: "backend"
---

# Python Backend

## Selection card
- Task: Implement or repair Python APIs, workers and typed validation.
- Start: Read pyproject.toml, the lockfile, the ASGI/WSGI entrypoint and the route or task being changed.
- Finish: the real entrypoint starts, the changed path answers correctly, and the checks below pass.

## Overview

A Python service fails in production at its boundaries: unvalidated input, blocking calls on the event loop, sessions that outlive their unit of work, and settings nobody checked at startup.
Checked 2026-11-02: Python 3.15.2, FastAPI 0.162.0, Django 6.1.2 and uv 0.13.6. Verify framework/native-wheel/Python support before combining them; latest Python can lead package support.
Type hints document intent; only Pydantic, serializers and forms enforce it at runtime.

## Rules

1. Never call blocking I/O inside `async def`. Use an async client (`httpx.AsyncClient`, `AsyncSession`), `asyncio.to_thread`, or declare the FastAPI endpoint as plain `def` so it runs in the threadpool.
2. Validate every untrusted payload at the boundary and return explicit response models; never serialize ORM rows or exception text directly.
3. One database session per unit of work, opened and closed by a context manager or `yield` dependency, with rollback on error. Never share one `AsyncSession` across concurrent tasks.
4. Every outbound call has a timeout. `requests` has none by default; `httpx` defaults to 5 seconds — set it deliberately either way.
5. Load settings once at startup through `pydantic-settings` or Django settings, fail fast on missing values, and keep secrets in `SecretStr` or the environment, never in code.
6. Authorize the object, not just the route: filter queries by owner/tenant at the query boundary.
7. Keep the project's package manager, framework and layout. A framework migration is its own task.
8. Re-raise `asyncio.CancelledError` after cleanup; never swallow it in `except Exception` or bare `except`.

## First moves by situation

| Situation | First moves |
|---|---|
| New endpoint | Find a sibling route; copy its dependency, schema and error conventions; add request and response models; write the failing test first |
| Endpoint slow or hangs under load | Look for sync clients, `time.sleep`, sync ORM calls inside `async def`; count queries per request; check pool size vs worker count |
| `MissingGreenlet` / `greenlet_spawn has not been called` | An async session lazy-loaded a relationship or touched an expired attribute; add `selectinload`/`joinedload` and `expire_on_commit=False` |
| 422 or validation surprise | Compare the Pydantic model to the payload; check lax coercion (`"1"` becomes `1`) versus `ConfigDict(strict=True)` |
| Django N+1 or slow admin | `select_related`/`prefetch_related`; prove the count with `assertNumQueries` |
| Python or framework upgrade | Read release notes and deprecations; run tests with `-W error::DeprecationWarning`; confirm native wheels exist for the new interpreter |
| Background job duplicated or lost | Check ack mode, broker visibility timeout versus task duration, and idempotency keys (hand off to queues-jobs for semantics) |
| Settings or secret leak | Grep for hard-coded keys, `DEBUG=True`, wildcard `ALLOWED_HOSTS`, secrets in logged reprs |

## Patterns and pitfalls

- **Lifespan owns shared clients** — create engines, `httpx.AsyncClient` and caches in FastAPI's `lifespan` context manager (the old `on_event` hooks are deprecated) and close them on exit. Module-level clients survive forks badly and never close.
- **`TestClient` lifespan** — FastAPI's `TestClient` only runs lifespan when used as `with TestClient(app) as client:`; outside the block, startup state is missing and tests pass for the wrong reason. Async tests: `httpx.AsyncClient(transport=ASGITransport(app=app))`.
- **`expire_on_commit=False`** — with `async_sessionmaker` this is required in practice: after commit, attribute access on expired objects triggers implicit I/O, which async sessions cannot do.
- **`lazy="raise"`** — on relationships in async code it turns a silent N+1 or `MissingGreenlet` into an immediate, testable error.
- **Pydantic v2 vocabulary** — `model_validate`, `model_dump`, `field_validator`, `model_config = ConfigDict(from_attributes=True)`; v1 names (`parse_obj`, `orm_mode`, `@validator`) are deprecated and some are removed.
- **Lax coercion** — Pydantic coerces by default. Money, IDs and flags that must not coerce need strict types (`StrictInt`, `StrictBool`) or strict model config.
- **Background tasks and request sessions** — work scheduled with `BackgroundTasks` must open its own session; the request's `yield` dependency may already have closed it.
- **Structured concurrency** — prefer `asyncio.TaskGroup` and `asyncio.timeout()` over bare `gather`; a failing child cancels its siblings and errors arrive as an `ExceptionGroup` (`except*`).
- **Django async ORM** — `aget`, `acreate`, `async for` exist, but `transaction.atomic` is sync-only: wrap a transactional block with `sync_to_async`. Django 6's `django.tasks` defines an API; confirm the configured backend actually runs a production worker.
- **Timezone-aware time** — `datetime.utcnow()` is deprecated; use `datetime.now(UTC)` and store aware timestamps.
- **Unsafe loaders** — `pickle`, `yaml.load` without `SafeLoader`, and f-string SQL in `text()` are injection paths; use bound parameters.
- **Workers multiply state** — Gunicorn/Uvicorn workers are separate processes; in-memory caches, rate limits and locks are per process unless backed by Redis or the database.

## Workflow

1. Map the path: router or view → dependency/service → ORM or client → response model. Note the framework conventions you must keep.
2. Confirm environment: interpreter version, `uv.lock`/`poetry.lock`/`requirements*.txt`, and how CI installs (`uv sync --locked`, `pip install -r`).
3. Write or extend a failing test at the boundary (valid input, invalid input, unauthorized, dependency failure).
4. Implement with explicit models, scoped sessions and timeouts; keep blocking work off the loop.
5. For schema changes, generate a migration (Alembic or `makemigrations`) and read the SQL before applying.
6. Run the proof commands below, then start the real entrypoint and hit the changed path.

## Proof

Prefer the project's own scripts (Makefile, `pyproject.toml` tasks, CI workflow). Common defaults:

- Lint and format: `uv run ruff check .` and `uv run ruff format --check .`
- Types: `uv run mypy .` or `uv run pyright`
- Tests: `uv run pytest -x -q` (add `-W error::DeprecationWarning` during upgrades)
- Lock integrity: `uv sync --locked` fails if the lockfile is stale
- Django: `python manage.py check --deploy`, `python manage.py makemigrations --check --dry-run`, `python manage.py migrate --plan`
- Alembic: `alembic upgrade head --sql` to read the SQL, `alembic check` for drift
- Smoke: `uv run uvicorn app.main:app --port 8000`, then `curl -fsS localhost:8000/healthz` and the changed route

## Stop and ask

- A migration drops or rewrites data, or locks a large table.
- The change would switch package manager, framework, ORM or Python major version.
- Required credentials, production databases or third-party sandboxes are not available locally.
- Tests can only pass by mocking the code under change.

## Before returning

- [ ] Python version, lockfile and native-wheel support confirmed for every changed dependency
- [ ] Untrusted input validated; responses go through explicit models with no internal fields
- [ ] No blocking call on the event loop; outbound calls have timeouts
- [ ] Sessions and transactions scoped per unit of work with rollback; no session shared across tasks
- [ ] Object-level authorization enforced in the query, not only the route
- [ ] Lint, type check and tests pass; migrations reviewed as SQL
- [ ] Real entrypoint started and the changed path exercised, with the observed result reported

## Sources

Versioned facts checked 2026-11-02; refresh authoritative sources before new installs/upgrades.
[Python releases](https://www.python.org/downloads/), [FastAPI](https://fastapi.tiangolo.com/), [Django](https://docs.djangoproject.com/en/stable/), [SQLAlchemy asyncio](https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html), [Pydantic](https://docs.pydantic.dev/latest/), [uv](https://docs.astral.sh/uv/).

## Skills in scope

- api-design — HTTP endpoint contracts, status codes, pagination, and OpenAPI schema fidelity.
- database-development — queries, transactions and bounded results behind the ORM.
- database-migrations — Alembic or Django migrations that must deploy without downtime.
- queues-jobs — Celery, RQ or Dramatiq delivery, retry and shutdown semantics.
- authentication-sessions — login, tokens and session rotation.
- testing — async pytest fixtures, transactional isolation and boundary error coverage.
