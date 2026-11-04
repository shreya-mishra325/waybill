FROM oven/bun:1.4.3-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/api/package.json ./packages/api/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/web/package.json ./packages/web/package.json
COPY packages/worker/package.json ./packages/worker/package.json
RUN bun install --frozen-lockfile --filter '@waybill/api' --filter '@waybill/shared'
COPY packages/shared ./packages/shared
COPY packages/api ./packages/api
RUN bun packages/shared/node_modules/prisma/build/index.js generate --schema packages/shared/prisma/schema.prisma
WORKDIR /app/packages/api
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
