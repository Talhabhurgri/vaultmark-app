# Debian slim, not Alpine — @napi-rs/canvas ships prebuilt binaries for
# glibc, not musl, so Alpine would either fail to load the native addon or
# silently fall back to a much slower pure-JS path. Not worth the smaller
# image size for a dependency this central (the OG share-image renderer).
FROM node:22-slim

WORKDIR /app

# Install deps first, separately from the app code, so `docker build` reuses
# this layer on every rebuild that only changes server.js/public/ — avoids
# re-running npm install (and re-downloading canvas's native binary) on
# every single code change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

# Data directory for the SQLite database — mounted as a volume in
# docker-compose.yml so it survives container rebuilds/restarts.
RUN mkdir -p /app/data
ENV DB_FILE=/app/data/vaultmark.db
ENV PORT=3000

# Runs as node's built-in non-root user rather than root — standard
# container hardening, costs nothing here.
RUN chown -R node:node /app
USER node

EXPOSE 3000

CMD ["node", "server.js"]
