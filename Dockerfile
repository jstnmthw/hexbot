FROM node:24-alpine AS builder

WORKDIR /app

# Install build tools for native addons (better-sqlite3)
RUN apk add --no-cache python3 make g++
RUN corepack enable

# Install all dependencies (including devDependencies for tsc)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm exec tsc

# ---

FROM node:24-alpine

WORKDIR /app

# Install build tools for native addons (better-sqlite3) and pnpm
RUN apk add --no-cache python3 make g++
RUN corepack enable

# Production dependencies only (fresh install = correct native binary for Alpine)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Config examples for first-run reference
COPY config/bot.example.json ./config/bot.example.json
COPY config/plugins.example.json ./config/plugins.example.json

CMD ["node", "dist/src/index.js"]
