# Express API image.
#
# Build context is the REPO ROOT, because the backend depends on the
# packages/shared workspace and needs the root lockfile:
#   docker build -f infrastructure/docker/backend.Dockerfile .

# --------------------------------------------------------------------------
# Stage 1: install dependencies (cached unless manifests change)
# --------------------------------------------------------------------------
FROM node:20-alpine AS deps

WORKDIR /app

# Copy only manifests first so edits to source do not bust the npm cache.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

# --ignore-scripts: no package's install hook should run arbitrary code here.
RUN npm ci --ignore-scripts

# --------------------------------------------------------------------------
# Stage 2: compile TypeScript
# --------------------------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY package.json package-lock.json ./
COPY packages/shared ./packages/shared
COPY backend ./backend

# The shared package must be built first; the backend imports its type output.
RUN npm run build --workspace @itp/shared \
  && npm run build --workspace @itp/backend

# Drop dev dependencies from the tree we are about to copy forward.
RUN npm prune --omit=dev --workspace @itp/backend --workspace @itp/shared

# --------------------------------------------------------------------------
# Stage 3: runtime
# --------------------------------------------------------------------------
FROM node:20-alpine AS production

# dumb-init gives PID 1 correct signal handling, so SIGTERM actually reaches
# Node and the graceful shutdown handler runs.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/
COPY --from=build --chown=node:node /app/backend/dist ./backend/dist
COPY --from=build --chown=node:node /app/backend/package.json ./backend/
COPY --from=build --chown=node:node /app/package.json ./

# Shared upload volume; must be writable by the unprivileged user.
RUN mkdir -p /app/storage && chown -R node:node /app/storage

# Never run as root.
USER node

EXPOSE 8080

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "backend/dist/server.js"]
