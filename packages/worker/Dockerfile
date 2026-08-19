FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lockb* ./
COPY packages/shared ./packages/shared
COPY packages/worker ./packages/worker
RUN bun install
WORKDIR /app/packages/worker
CMD ["bun", "run", "src/index.ts"]
