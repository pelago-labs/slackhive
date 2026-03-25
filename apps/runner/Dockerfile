FROM node:20-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ curl && rm -rf /var/lib/apt/lists/*

# Install deps
FROM base AS deps
COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/runner/package.json ./apps/runner/
RUN npm install

# Build
FROM deps AS builder
COPY packages/shared ./packages/shared
COPY apps/runner ./apps/runner
RUN cd packages/shared && npx tsc --skipLibCheck || true
RUN cd apps/runner && npx tsc --skipLibCheck || true

# Runtime
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/apps/runner ./apps/runner
COPY --from=builder /app/package.json ./

# Install uvx for openmetadata MCP
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && ln -s /root/.local/bin/uvx /usr/local/bin/uvx || true

CMD ["node", "apps/runner/dist/index.js"]
