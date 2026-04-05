FROM node:24-alpine

WORKDIR /app

# Install build tools for native addons (better-sqlite3)
RUN apk add --no-cache python3 make g++
RUN corepack enable

# Install dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild better-sqlite3

# Copy source and plugin code
COPY tsconfig.json ./
COPY src/ ./src/
COPY plugins/ ./plugins/

# Typecheck at build time (catches errors before deploy)
RUN pnpm exec tsc --noEmit

# Config examples for first-run reference
COPY config/bot.example.json ./config/bot.example.json
COPY config/plugins.example.json ./config/plugins.example.json
COPY config/bot.env.example ./config/bot.env.example

CMD ["pnpm", "start"]
