FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat docker-cli

# Install all workspace deps
FROM base AS deps
COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/
RUN npm install

# Build
FROM deps AS builder
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
RUN cd packages/shared && npx tsc --skipLibCheck || true
RUN cd apps/web && npx next build

# Runtime
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app/apps/web
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/packages/shared /app/packages/shared
COPY --from=builder /app/apps/web/.next ./.next
COPY --from=builder /app/apps/web/public ./public
COPY --from=builder /app/apps/web/package.json ./
COPY --from=builder /app/apps/web/next.config.js ./
COPY --from=builder /app/package.json /app/

EXPOSE 3000
CMD ["npx", "next", "start"]
