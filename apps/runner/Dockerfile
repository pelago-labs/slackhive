FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache curl

# Install deps
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/runner/package.json ./apps/runner/
RUN npm ci

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
# Install git, Python, pip and graphify for Bash-enabled agents
RUN apk add --no-cache git python3 py3-pip && \
    pip3 install --break-system-packages graphifyy
COPY --from=builder /app/node_modules ./node_modules
# Create claude wrapper that uses the SDK's bundled CLI
RUN printf '#!/bin/sh\ncd /app/node_modules/@anthropic-ai/claude-agent-sdk && exec node cli.js "$@"\n' > /usr/local/bin/claude && \
    chmod +x /usr/local/bin/claude
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/apps/runner ./apps/runner
COPY --from=builder /app/package.json ./

CMD ["node", "apps/runner/dist/index.js"]
