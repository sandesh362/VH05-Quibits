# Frontend image: build the static bundle, serve it with nginx.
#
# nginx also reverse-proxies /api to the Express container, which means the
# browser only ever talks to one origin. No CORS, one URL to demo.
#
# Build context is the REPO ROOT:
#   docker build -f infrastructure/docker/frontend.Dockerfile .

# --------------------------------------------------------------------------
# Stage 1: build the bundle
# --------------------------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

RUN npm ci --ignore-scripts

COPY packages/shared ./packages/shared
COPY frontend ./frontend

# Baked in at build time - Vite inlines VITE_* variables into the bundle.
# Relative by default so the browser calls nginx, never a service host.
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN npm run build --workspace @itp/shared \
  && npm run build --workspace @itp/frontend

# --------------------------------------------------------------------------
# Stage 2: serve
# --------------------------------------------------------------------------
FROM nginx:1.27-alpine AS production

# Replace the stock config with one that knows about SPA routing and /api.
RUN rm /etc/nginx/conf.d/default.conf
COPY infrastructure/docker/nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=build /app/frontend/dist /usr/share/nginx/html

EXPOSE 80

# nginx handles SIGTERM correctly on its own.
CMD ["nginx", "-g", "daemon off;"]
