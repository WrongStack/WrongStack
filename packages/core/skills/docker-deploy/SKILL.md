---
name: docker-deploy
description: |
  Use this skill when writing or reviewing a Dockerfile, docker-compose setup, or container image build for a project, or when debugging a container that won't build, start, or stay healthy.
  Triggers: user says "docker", "Dockerfile", "container", "image", "docker compose", "containerize", "multi-stage", "distroless", "registry", "healthcheck", "image size".
version: 2.1.1
required-capabilities: [filesystem.read, filesystem.write, execution.shell]
required-tools: []
trigger: "Use this skill when writing or reviewing a Dockerfile, docker-compose setup, or container image build for a project, or when debugging a container that won't build, start, or stay healthy."
metadata:
  routing-group: operations
---

# Docker Deploy

## Selection card
- Task: Build and deploy a reproducible container image.
- Start: Identify the authorized target, current health and rollback boundary.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

A good image is small, reproducible, runs as a non-root user, and rebuilds
quickly because its layers are ordered by how often they change. Start from the
project as it is: the language and package manager (lockfile), the build
command, the start command, the port, and what the process needs at runtime
(environment, volumes, writable paths).

## Rules

1. **Pre-flight: Inspect repo manifests & live base image registries first.** Inspect `package.json`,
   lockfiles, and existing `Dockerfile` / `compose.yaml`. Query Docker Hub or live container registries
   to find current stable base image tags (e.g. `node:26.11.1-bookworm-slim`, `postgres:18.6-alpine`)
   before configuring builds. Latest stable PostgreSQL is 18.6 (19 is beta),
   checked 2026-10-09 against https://www.postgresql.org/support/versioning/.
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

## Patterns

Node.js service with pnpm:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:26.11.1-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@12.10.1
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:26.11.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
```

Build-time secret without baking it into a layer:

```dockerfile
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc pnpm install --frozen-lockfile
```

```bash
docker build --secret id=npmrc,src=$HOME/.npmrc -t app:$(git rev-parse --short HEAD) .
```

Compose for local development (the top-level `version:` key is obsolete):

```yaml
services:
  app:
    build: .
    ports: ["3000:3000"]
    env_file: .env
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:18.6
    environment:
      POSTGRES_PASSWORD: dev-only
    volumes: [db-data:/var/lib/postgresql]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      retries: 10
volumes:
  db-data:
```

## Debugging a container

| Symptom | Check |
|---|---|
| Build cache never hits | Source copied before the dependency install; missing `.dockerignore` |
| Exits immediately | `docker logs <id>`; the `CMD` path relative to `WORKDIR`; missing build output in the runtime stage |
| Works locally, fails in the image | Missing runtime env var, native module built for a different libc (alpine vs glibc), dev dependency needed at runtime |
| Permission denied | Writing to a path owned by root while running as non-root |
| Ctrl+C or stop takes 10 s | Shell-form `CMD` swallowing signals; no init process |
| Unhealthy | Run the healthcheck command yourself inside the container |

## Anti-patterns

- **`COPY . .` before installing dependencies** — every source change reinstalls everything.
- **Secrets in `ARG`/`ENV`** — visible in image history to anyone who pulls it.
- **Running as root** "because it works".
- **`latest` tags** in anything deployed.
- **One giant stage** that ships compilers and dev dependencies to production.

## Before returning

- [ ] Multi-stage; runtime stage holds only production artifacts
- [ ] Base image pinned; dependencies installed from the lockfile
- [ ] Layers ordered so source changes don't invalidate the install
- [ ] Non-root user; no secrets in layers; `.dockerignore` present
- [ ] Exec-form start command; healthcheck for services
- [ ] Image built and the container started successfully, if the environment allows

## Reproducibility and deployment proof

For new Node targets, current stable is 26.11.1 as checked 2026-10-09; verify
the official release schedule, available image tags and adapter support before
choosing a base. Corepack availability varies by Node release: provision the
declared package manager explicitly and pin its version. The example uses the checked stable target; verify tag availability
and pin the selected image digest before a production release.
For monorepos, include workspace manifests/config and required runtime assets;
single-package prune examples may break symlinks or workspace dependencies.
Build and run the final stage, check binding/readiness and stop behavior.
Record image digest; local startup and live redeployment are separate proofs.

## Skills in scope

- `security-scanner` — for image and configuration exposure review
- `observability` — for logs and health endpoints in containers
- `tech-stack` — for choosing and pinning base image versions
