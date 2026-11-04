FROM oven/bun:1.4.3-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/api/package.json ./packages/api/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/web/package.json ./packages/web/package.json
COPY packages/worker/package.json ./packages/worker/package.json
RUN bun install --frozen-lockfile --filter '@waybill/worker' --filter '@waybill/shared'
COPY packages/shared ./packages/shared
COPY packages/worker ./packages/worker
RUN bun packages/shared/node_modules/prisma/build/index.js generate --schema packages/shared/prisma/schema.prisma
WORKDIR /app/packages/worker
CMD ["bun", "run", "src/index.ts"]
