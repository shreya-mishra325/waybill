FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lockb* ./
COPY packages/shared ./packages/shared
COPY packages/api ./packages/api
RUN bun install
WORKDIR /app/packages/api
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
