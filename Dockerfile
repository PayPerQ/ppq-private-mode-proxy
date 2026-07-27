# Build stage: compile TypeScript
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY bin ./bin
COPY lib ./lib
COPY index.ts ./
RUN npm ci

# Runtime stage: production dependencies only
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist

# Bind to all interfaces inside the container; publish the port to reach it
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

USER node
CMD ["node", "dist/bin/server.js"]
