# syntax=docker/dockerfile:1.7

# Pinned by DIGEST, not by tag alone. A tag is mutable — `node:22.23.2-bookworm-slim`
# can be re-pushed to different content, so a tag-only pin means two builds of
# the same source can produce different base layers, and a compromised upstream
# tag lands silently. The digest makes the base bit-for-bit reproducible.
#
# This is the multi-arch INDEX digest (`application/vnd.oci.image.index.v1+json`),
# not a per-platform manifest digest, so linux/amd64, arm64, arm and ppc64le all
# continue to resolve. Verify or refresh with:
#   docker buildx imagetools inspect node:<version>-bookworm-slim
#
# Overriding `--build-arg NODE_IMAGE=…` REMOVES this pin. That is left possible
# on purpose (air-gapped mirrors need it) and is not a trust boundary: whoever
# runs the build already controls the build. Point it at your own registry's
# digest rather than a bare tag.
ARG NODE_IMAGE=node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

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
