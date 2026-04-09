FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache curl

# Install deps
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/runner/package.json ./apps/runner/
RUN npm ci --prefer-offline

# Build
FROM deps AS builder
COPY packages/shared ./packages/shared
COPY apps/runner ./apps/runner
RUN cd packages/shared && npx tsc --skipLibCheck || true
RUN cd apps/runner && npx tsc --skipLibCheck || true

# Runtime — lean image, no build tools
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/apps/runner ./apps/runner
COPY --from=builder /app/package.json ./

CMD ["node", "apps/runner/dist/index.js"]
