FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work

# 開發工具仍由 compose.yaml bind mount 原始碼，與交付映像分開。
FROM base AS tools

FROM base AS dependencies
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts

FROM dependencies AS build
COPY tsconfig*.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
COPY web ./web
COPY scripts/release-task.cjs scripts/check-operations-data.cjs ./scripts/
ARG RELEASE_ID=chapter-30-local
RUN DATABASE_URL=postgresql://build:unused@127.0.0.1:1/build npm run generate \
    && npm run build \
    && ./node_modules/.bin/tsc -p tsconfig.runtime.json \
    && node dist/generate-export.js \
    && node -e 'const id=process.env.RELEASE_ID;if(!/^[a-zA-Z0-9._-]{1,80}$/.test(id))process.exit(1);require("node:fs").writeFileSync("release.json",JSON.stringify({releaseId:id}))'

FROM base AS production-dependencies
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --omit=optional --omit=peer --ignore-scripts

# CLI 與 schema 只供獨立 release 工作；不把 CLI 放入 API runtime。
FROM build AS migration
ARG RELEASE_ID=chapter-30-local
LABEL org.opencontainers.image.revision=$RELEASE_ID
USER node
ENTRYPOINT ["node", "scripts/release-task.cjs"]
CMD ["migrate"]

FROM base AS runtime
WORKDIR /app
ARG RELEASE_ID=chapter-30-local
LABEL org.opencontainers.image.revision=$RELEASE_ID
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 SHUTDOWN_TIMEOUT_MS=3000
COPY --from=production-dependencies /work/node_modules ./node_modules
COPY --from=build /work/.runtime-dist ./dist
COPY --from=build /work/web ./web
COPY --from=build /work/.data/articles.ndjson ./.data/articles.ndjson
COPY --from=build /work/release.json ./release.json
COPY package.json ./package.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=4s --start-period=10s --retries=6 CMD ["node", "dist/readiness-probe.js"]
ENTRYPOINT ["node", "--enable-source-maps", "dist/main.js"]

FROM base AS verifier
COPY scripts/check-production.cjs ./scripts/check-production.cjs
ENTRYPOINT ["node", "scripts/check-production.cjs"]

FROM tools AS browser
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
