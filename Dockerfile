FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install deps first for layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public

# Config is bind-mounted at runtime (see docker-compose.yml)
RUN mkdir -p /app/config

EXPOSE 8080
USER node

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:8080/api/health >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
