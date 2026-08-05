FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run postinstall && npm run build

FROM node:22-bookworm-slim AS web

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
RUN mkdir -p /app/data && chown -R node:node /app
COPY --from=build --chown=node:node /app/.output ./.output
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]

FROM node:22-bookworm-slim AS tasks

ENV NODE_ENV=production
WORKDIR /app
COPY deploy/tasks/package.json deploy/tasks/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node db ./db
COPY --chown=node:node worker ./worker
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node fixtures ./fixtures
COPY --chown=node:node compose.yaml ./release/compose.yaml
COPY --chown=node:node deploy/Caddyfile deploy/production-deploy.sh ./release/deploy/
RUN mkdir -p /app/data && chown -R node:node /app
USER node
CMD ["npm", "run", "worker:start"]
