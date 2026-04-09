FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat docker-cli curl && \
    npm install -g tsx

# Install all workspace deps
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/
RUN npm ci --prefer-offline

# Build
FROM deps AS builder
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
RUN cd packages/shared && npx tsc --skipLibCheck || true
ARG AUTH_SECRET
ARG ADMIN_PASSWORD
ENV AUTH_SECRET=$AUTH_SECRET
ENV ADMIN_PASSWORD=$ADMIN_PASSWORD
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
