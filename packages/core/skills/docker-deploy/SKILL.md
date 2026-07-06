---
name: docker-deploy
description: |
  Use this skill when building, containerizing, or deploying WrongStack
  with Docker. Triggers: user says "docker", "container", "dockerfile",
  "image", "docker-compose", "deploy", "containerize", "registry",
  "multi-stage", "distroless".
version: 1.0.0
---

# Docker Deploy — WrongStack

## Overview

Containerizes and deploys WrongStack with Docker. WrongStack is a Node.js CLI tool — containerize it for CI/CD, cloud deployment, or self-hosted setups. Use multi-stage builds to keep images small and distroless base images for security.

## Rules

1. Multi-stage build: build stage (with dev deps) + runtime stage (production deps only).
2. Use `node:*` base image with pinned version — not `node:latest`.
3. Never run as root in the container — use a non-root user.
4. Pass secrets via environment variables, not baked into the image.
5. Health check: `docker healthcheck` pointing to the CLI's self-check command.
6. Tag images with git SHA: `wrongstack:$GIT_SHA` — never `latest` in production.
7. Scan images for vulnerabilities: `trivy image` or `docker scout` before push.
8. Use `.dockerignore` to exclude `node_modules`, `dist`, `.git`, `*.test.ts`.

## Patterns

### Do

```dockerfile
# ✅ Multi-stage build — small production image
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml .pnpmfile.cjs ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
# Copy only what's needed
COPY --from=builder /app/packages/cli/dist ./dist/
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/packages/cli/package.json ./

# Non-root user
RUN addgroup -S wrongstack && adduser -S wrongstack -G wrongstack
USER wrongstack

ENTRYPOINT ["node", "dist/index.js"]
```

```yaml
# ✅ docker-compose.yml — development
version: '3.9'
services:
  wrongstack:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - WRONGSTACK_CONFIG_DIR=/app/.wrongstack
      - WRONGSTACK_SESSION_ROOT=/app/sessions
    volumes:
      - .:/app
      - wrongstack-data:/app/.wrongstack
    stdin_open: true
    tty: true

volumes:
  wrongstack-data:
```

```bash
# ✅ Build with git SHA tag
IMAGE_TAG="wrongstack:$(git rev-parse --short HEAD)"
docker build -t "$IMAGE_TAG" .
docker tag "$IMAGE_TAG" "registry.example.com/wrongstack:$IMAGE_TAG"
docker push "registry.example.com/wrongstack:$IMAGE_TAG"
```

### Don't

```dockerfile
# ❌ Running as root
FROM node:22
WORKDIR /app
COPY . .
RUN npm install && npm run build
ENTRYPOINT ["npm", "start"]

# ❌ No .dockerignore — copies everything
# node_modules, .git, dist/ end up in the image

# ❌ Secrets baked into image
ARG API_KEY
RUN echo $API_KEY > /app/config.key  # ❌
```

## Dockerfile best practices

| Practice | Why |
|----------|-----|
| Pin base image version | `node:22-alpine` not `node:latest` |
| Multi-stage build | 1GB → ~150MB image size |
| Non-root user | Security: container compromise ≠ host root |
| `.dockerignore` | Smaller image, faster builds |
| No `latest` tag | Reproducibility — you always know which SHA |
| Health check | Kubernetes/docker-compose health monitoring |

## Environment variables

```bash
# Required at runtime
WRONGSTACK_CONFIG_DIR=/app/.wrongstack
WRONGSTACK_SESSION_ROOT=/app/sessions

# Optional
WRONGSTACK_PROVIDER=anthropic
WRONGSTACK_MODEL=<model-id>
WRONGSTACK_API_KEY=${ANTHROPIC_API_KEY}  # from secrets manager
```

## Health check

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node dist/index.js diag-doctor || exit 1
```

## Image scanning

```bash
# Scan before push
trivy image wrongstack:$GIT_SHA

# Block critical vulnerabilities
trivy image --exit-code 1 --ignore-unfixed --severity HIGH,CRITICAL wrongstack:$GIT_SHA
```

## WrongStack-specific notes

- **WrongStack CLI entry point**: `packages/cli/dist/index.js` after build.
- **pnpm workspaces**: Build from repo root — `pnpm -r build` before `docker build`.
- **Session storage**: Sessions are stored at `WRONGSTACK_SESSION_ROOT` — mount a volume for persistence.
- **Config**: Config is at `WRONGSTACK_CONFIG_DIR` — mount for config persistence across restarts.

## Skills in scope

- `security-scanner` — for scanning Dockerfiles and container configs for vulnerabilities
- `git-flow` — for tagging releases and managing Docker image versions
- `node-modern` — for Node.js-specific containerization patterns
- `observability` — for logging and tracing in containerized environments
- `output-standards` — for standardized `<nextsteps>` formatting
