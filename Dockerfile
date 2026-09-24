FROM node:22-alpine AS build

WORKDIR /app
ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

COPY package.json package-lock.json ./
RUN npm ci --loglevel=error

COPY . .
RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080

RUN addgroup -S app && adduser -S -G app app

COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app server.mjs ./server.mjs

USER app
EXPOSE 8080

CMD ["node", "server.mjs"]
