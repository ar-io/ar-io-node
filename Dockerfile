FROM node:16-alpine as builder

# BUILD
WORKDIR /app
RUN apk --no-cache add git
COPY . .
RUN yarn install
RUN yarn build

# EXTRACT DIST
FROM node:16-alpine
WORKDIR /app
RUN apk add --no-cache sqlite curl

COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist/ ./dist/
COPY ./migrations /app/migrations
COPY ./docker-entrypoint.sh /app/docker-entrypoint.sh
COPY ./docs/openapi.yaml /app/docs/openapi.yaml

# CREATE VOLUME
VOLUME /app/data

# EXPOSE PORT AND SETUP HEALTHCHECK
EXPOSE 3000
HEALTHCHECK CMD curl --fail http://localhost:3000 || exit 1

# START
ENTRYPOINT [ "/bin/sh", "docker-entrypoint.sh" ]
