# Docker Deploy (Compact)

<!-- source-version: 2.1.4 -->

## Selection card
- Task: Build and deploy a reproducible container image. / TR: Tekrarlanabilir container imajı kur ve deploy et.
- Start: Read the Dockerfile, compose files, .dockerignore and how CI builds and runs the image.
- Finish: The image builds from a clean cache, runs as non-root, passes its healthcheck, and size and layer changes are reported.

## Overview

A good image is small, reproducible, runs as a non-root user, and rebuilds
quickly because its layers are ordered by how often they change. Start from the
project as it is: the language and package manager (lockfile), the build
command, the start command, the port, and what the process needs at runtime
(environment, volumes, writable paths).

## Rules

1. **Pre-flight: Inspect repo manifests & live base image registries first.** Inspect `package.json`,
   lockfiles, and existing `Dockerfile` / `compose.yaml`. Query Docker Hub or live container registries
   to find current stable base image tags (e.g. `node:26.13.0-bookworm-slim`, `postgres:18.6-alpine`)
   before configuring builds. Latest stable PostgreSQL is 18.6 (19 is beta),
   checked 2026-11-02 against https://www.postgresql.org/support/versioning/.
2. Multi-stage builds: build with the toolchain and dev dependencies, ship a
   runtime stage with only production artifacts.
3. Pin the base image to a specific version tag (optionally a digest); never
   `latest`.
3. Order layers for caching: copy dependency manifests and the lockfile,
   install, then copy the source.
4. Install from the lockfile (`npm ci`, `pnpm install --frozen-lockfile`,
   `pip install -r` with hashes, `go mod download`).
5. Run as a non-root user, and make only the paths the app writes to writable.
6. No secrets in the image — no `ARG`/`ENV` for credentials, no copied `.env`.
   Pass them at runtime, or use BuildKit secret mounts for build-time access.
7. Use the exec form for `ENTRYPOINT`/`CMD` so signals reach the process, and
   add an init (`--init`, or `tini`) when the app spawns children.
8. Keep a `.dockerignore` that excludes `.git`, dependency folders, build output,
   local env files, and tests.
9. Add a `HEALTHCHECK` for long-running services, pointing at a cheap readiness
   endpoint; one-shot jobs and CLIs don't need one.

## Detailed workflow

Load the full docker-deploy skill before relying on its specialized modes,
references or output contracts. Its current SKILL.md is the source of truth;
this compact body does not expand task scope or authorization.

## Before returning

- [ ] Multi-stage; runtime stage holds only production artifacts
- [ ] Base image pinned; dependencies installed from the lockfile
- [ ] Layers ordered so source changes don't invalidate the install
- [ ] Non-root user; no secrets in layers; `.dockerignore` present
- [ ] Exec-form start command; healthcheck for services
- [ ] Image built and the container started successfully, if the environment allows
