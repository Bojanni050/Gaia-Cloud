# The Gaia API. Build context is this service's own directory (see
# docker-compose.yml) — identity is self-contained here since SOUL moved
# to services/gaia-api/identity/ (centralized in Gaia Cloud, versioned).
# One source of truth for identity: the repo's constitution file, read at
# container start. A Gaia API without SOUL refuses to start.
#
# foundation-artifact.json (the other foundation documents — principles,
# lexicon, architecture, evolution — used for docs/web-migration-plan.md's
# Phase B context-aware document selection) is NOT built here: it's
# materialized into this directory by the deploy step, before `docker
# build` runs (see .github/workflows/deploy.yml), by running
# scripts/build-foundation-artifact.js from the repo root — reusing the
# same generator Gaia-Cloud's publish-foundation.yml already uses, rather
# than widening this build's context back to the repo root.

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./package.json
RUN npm install --omit=dev

# Generate build metadata at build time
COPY scripts ./scripts
RUN node scripts/generate-build-meta.js

COPY src ./src
COPY public ./public
COPY identity/soul.md ./soul.md
COPY foundation-artifact.json ./foundation-artifact.json
COPY build-meta.json ./build-meta.json

ENV SOUL_PATH=/app/soul.md
EXPOSE 8891
CMD ["node", "src/server.js"]
