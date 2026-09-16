FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true
RUN corepack enable
WORKDIR /app

FROM base AS deps
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
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN PNPM_CONFIG_RECURSIVE_INSTALL=false pnpm build

FROM base AS runtime
ARG TRIAGEPILOT_VERSION=1.0.0
ARG TRIAGEPILOT_GIT_COMMIT=unknown
ARG TRIAGEPILOT_PUBLISHED_AT=1970-01-01T00:00:00.000Z
ARG TRIAGEPILOT_FUTURE_LICENSE_EFFECTIVE_AT=1972-01-01T00:00:00.000Z
LABEL org.opencontainers.image.version=$TRIAGEPILOT_VERSION \
      org.opencontainers.image.revision=$TRIAGEPILOT_GIT_COMMIT \
      org.opencontainers.image.licenses="FSL-1.1-Apache-2.0" \
      org.opencontainers.image.created=$TRIAGEPILOT_PUBLISHED_AT \
      org.triagepilot.future-license-effective-at=$TRIAGEPILOT_FUTURE_LICENSE_EFFECTIVE_AT
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 8787
CMD ["pnpm", "--filter", "@triagepilot/web", "start"]
