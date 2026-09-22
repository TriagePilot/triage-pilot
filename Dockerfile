# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS toolchain
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true
RUN corepack enable
WORKDIR /app

FROM toolchain AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/provider-github/package.json packages/provider-github/package.json
RUN --mount=type=cache,id=triagepilot-pnpm,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM deps AS prod-deps
RUN --mount=type=cache,id=triagepilot-pnpm,target=/pnpm/store,sharing=locked \
    rm -rf \
      node_modules \
      apps/web/node_modules \
      apps/worker/node_modules \
      packages/application/node_modules \
      packages/config/node_modules \
      packages/contracts/node_modules \
      packages/core/node_modules \
      packages/db/node_modules \
      packages/provider-github/node_modules \
      packages/shared/node_modules \
      packages/ui/node_modules && \
    pnpm install --prod --offline --frozen-lockfile \
      --filter '@triagepilot/web...' \
      --filter '@triagepilot/worker...'

FROM build AS runtime-artifacts
RUN find \
      /app/apps/web/dist \
      /app/apps/worker/dist \
      /app/packages/application/dist \
      /app/packages/config/dist \
      /app/packages/contracts/dist \
      /app/packages/core/dist \
      /app/packages/db/dist \
      /app/packages/provider-github/dist \
      /app/packages/shared/dist \
      -type f \( -name '*.d.ts' -o -name '*.map' \) -delete

FROM node:24-bookworm-slim AS runtime
ARG TRIAGEPILOT_VERSION=1.1.0
ARG TRIAGEPILOT_GIT_COMMIT=unknown
ARG TRIAGEPILOT_PUBLISHED_AT=1970-01-01T00:00:00.000Z
ARG TRIAGEPILOT_FUTURE_LICENSE_EFFECTIVE_AT=1972-01-01T00:00:00.000Z
LABEL org.opencontainers.image.version=$TRIAGEPILOT_VERSION \
      org.opencontainers.image.revision=$TRIAGEPILOT_GIT_COMMIT \
      org.opencontainers.image.licenses="FSL-1.1-Apache-2.0" \
      org.opencontainers.image.created=$TRIAGEPILOT_PUBLISHED_AT \
      org.triagepilot.future-license-effective-at=$TRIAGEPILOT_FUTURE_LICENSE_EFFECTIVE_AT
ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node LICENSE ./LICENSE
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=prod-deps --chown=node:node /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/application/node_modules ./packages/application/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/config/node_modules ./packages/config/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/provider-github/node_modules ./packages/provider-github/node_modules

COPY --from=build --chown=node:node /app/apps/web/package.json ./apps/web/package.json
COPY --from=runtime-artifacts --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=runtime-artifacts --chown=node:node /app/apps/worker/dist ./apps/worker/dist

COPY --from=build --chown=node:node /app/packages/application/package.json ./packages/application/package.json
COPY --from=runtime-artifacts --chown=node:node /app/packages/application/dist ./packages/application/dist
COPY --from=build --chown=node:node /app/packages/config/package.json ./packages/config/package.json
COPY --from=runtime-artifacts --chown=node:node /app/packages/config/dist ./packages/config/dist
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=runtime-artifacts --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/core/package.json ./packages/core/package.json
COPY --from=runtime-artifacts --chown=node:node /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /app/packages/db/package.json ./packages/db/package.json
COPY --from=runtime-artifacts --chown=node:node /app/packages/db/dist ./packages/db/dist
COPY --from=build --chown=node:node /app/packages/db/migrations ./packages/db/migrations
COPY --from=build --chown=node:node /app/packages/provider-github/package.json ./packages/provider-github/package.json
COPY --from=runtime-artifacts --chown=node:node /app/packages/provider-github/dist ./packages/provider-github/dist
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=runtime-artifacts --chown=node:node /app/packages/shared/dist ./packages/shared/dist

USER node
EXPOSE 8787
CMD ["node", "apps/web/dist/server.js"]
