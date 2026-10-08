# The hosted demo's long-lived half (ADR-035): the realtime service, the simulated
# Observatory Agents that dial out to it, and the Caddy front that puts the website,
# the API and realtime on one host. Built from the repository root:
#   fly deploy --config deploy/fly/fly.toml --dockerfile deploy/fly/Dockerfile .

FROM node:24-bookworm-slim AS node
FROM caddy:2.10 AS caddy

FROM python:3.12-slim-bookworm

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy

WORKDIR /app

# The agent: SIMULATED drivers only. ZWO and Alpaca are never installed in this image.
COPY agent/pyproject.toml agent/pyproject.toml
COPY agent/darkview_agent agent/darkview_agent
COPY agent/contracts agent/contracts
RUN python -m venv /opt/agent && /opt/agent/bin/pip install --no-cache-dir ./agent

# Realtime and the workspaces it imports. tsx runs it, as `npm start` does.
COPY package.json package-lock.json ./
COPY apps/realtime/package.json apps/realtime/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/storage/package.json packages/storage/package.json
RUN npm ci --ignore-scripts \
      --workspace @darkview/realtime --workspace @darkview/db \
      --workspace @darkview/contracts --workspace @darkview/storage \
      --include-workspace-root
COPY apps/realtime apps/realtime
COPY packages packages
RUN npm run db:generate --workspace @darkview/db

COPY deploy/fly/Caddyfile /etc/caddy/Caddyfile
COPY deploy/fly/start.sh /app/start.sh

ENV NODE_ENV=production
EXPOSE 8080
CMD ["/app/start.sh"]
