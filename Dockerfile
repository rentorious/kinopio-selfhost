# syntax=docker/dockerfile:1

# 1. The Kinopio client at the pinned commit, with our patches, built for same-origin hosting.
FROM node:22-slim AS client
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY client/ ./client/
RUN KINOPIO_CLIENT_WORKDIR=/build/kinopio-client bash client/build.sh /build/client-dist

# 2. The server.
FROM node:22-slim AS server
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --loglevel=error
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# 3. Runtime: one process serves the client, the API and (later) files and the websocket.
FROM node:22-slim
ENV NODE_ENV=production CLIENT_DIST=/app/client-dist
WORKDIR /app
COPY --from=server /app/package.json ./
COPY --from=server /app/node_modules ./node_modules
COPY --from=server /app/dist ./dist
COPY --from=client /build/client-dist ./client-dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
