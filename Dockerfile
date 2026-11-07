# Multi-arch: works on x86_64 and arm64 (better-sqlite3 ships prebuilt binaries for both).
FROM node:26-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: better-sqlite3 ships prebuilt binaries for x64/arm64, so skip the
# node-gyp compile npm would otherwise attempt (needs python/g++, slow on a 1 GB VM).
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26-trixie-slim
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=192 \
    TZ=Europe/Amsterdam
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
RUN mkdir -p auth data && chown node:node auth data
USER node
CMD ["node", "dist/index.js"]
