FROM oven/bun:1-alpine AS base

FROM base AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

RUN addgroup --system --gid 1001 fishfacts \
  && adduser --system --uid 1001 fishfacts

COPY --from=deps --chown=fishfacts:fishfacts /app/node_modules ./node_modules
COPY --chown=fishfacts:fishfacts package.json ./
COPY --chown=fishfacts:fishfacts src ./src
COPY --chown=fishfacts:fishfacts drizzle ./drizzle
COPY --chown=fishfacts:fishfacts drizzle.config.ts ./
COPY --chown=fishfacts:fishfacts tsconfig.json ./

USER fishfacts

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

CMD ["bun", "run", "src/index.ts"]
