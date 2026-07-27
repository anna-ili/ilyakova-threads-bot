FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@0.133.0 \
    && mkdir -p /tmp/ilyakova-codex-work \
    && chown -R node:node /tmp/ilyakova-codex-work

COPY --chown=node:node --from=build /app/package.json ./
COPY --chown=node:node --from=build /app/package-lock.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/.next ./.next

EXPOSE 3000

USER node

CMD ["npm", "run", "start"]
