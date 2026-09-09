# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22.23.2-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /workspace
ENV CI=1

RUN corepack enable && corepack prepare pnpm@12.3.4 --activate
COPY . .
RUN --mount=type=cache,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --ignore-scripts && \
    pnpm rebuild esbuild
RUN node scripts/build.mjs --target wrongstack
RUN --mount=type=cache,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm --filter wrongstack deploy --prod --no-optional --ignore-scripts /opt/wrongstack

FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="WrongStack HQ" \
      org.opencontainers.image.description="WrongStack cross-machine command center" \
      org.opencontainers.image.source="https://github.com/WrongStack/WrongStack"

ENV NODE_ENV=production \
    HOME=/var/lib/wrongstack-hq \
    WRONGSTACK_HOME=/var/lib/wrongstack-hq \
    WRONGSTACK_HQ_DATA_DIR=/var/lib/wrongstack-hq/hq \
    WRONGSTACK_HQ_CONTAINER=1 \
    WRONGSTACK_HQ_BOOTSTRAP_PASSWORD_ONLY=1 \
    WRONGSTACK_HQ_SUPPRESS_STARTUP_SECRETS=1

RUN mkdir -p /var/lib/wrongstack-hq/hq && chown -R node:node /var/lib/wrongstack-hq
COPY --from=build --chown=node:node /opt/wrongstack /opt/wrongstack

USER node
WORKDIR /var/lib/wrongstack-hq
VOLUME ["/var/lib/wrongstack-hq"]
EXPOSE 3499
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3499/healthz',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "/opt/wrongstack/dist/index.js", "hq", "serve", "--host", "0.0.0.0", "--port", "3499", "--strict-port"]
