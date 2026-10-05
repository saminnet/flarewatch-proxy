FROM --platform=$BUILDPLATFORM cgr.dev/chainguard/node:latest-dev@sha256:863f9869715829bed9ce7510345459f00ca9d96f7d764b3b9d1d56f018fbc243 AS builder

WORKDIR /app

COPY --chown=65532:65532 package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile

COPY --chown=65532:65532 . .

RUN pnpm compile

RUN pnpm build

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

RUN rm -rf \
    /usr/local/lib/node_modules/npm \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/lib/node_modules/corepack \
    /usr/local/bin/corepack \
    /opt/yarn* \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg

COPY --chown=node:node --from=builder /app/dist/index.mjs ./dist/index.mjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1

USER node

CMD ["node", "dist/index.mjs"]
