# =============================================================================
# Runner Service Dockerfile
# Multi-stage build: install deps → build TypeScript → minimal runtime image
# =============================================================================

FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++

# Install dependencies
FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/runner/package.json ./apps/runner/
RUN npm ci --workspace=apps/runner --workspace=packages/shared

# Build shared package then runner
FROM deps AS builder
COPY packages/shared ./packages/shared
COPY apps/runner ./apps/runner
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=apps/runner

# Runtime image
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/apps/runner/dist ./apps/runner/dist
COPY --from=builder /app/apps/runner/package.json ./apps/runner/

CMD ["node", "apps/runner/dist/index.js"]
