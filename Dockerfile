FROM node:16-alpine as builder

# BUILD
WORKDIR /app
RUN apk --no-cache add g++ git python3 make
COPY . .
RUN yarn install
RUN yarn build
RUN rm -rf node_modules # remove dev deps to reduce image size
RUN yarn install --production

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
EXPOSE 4000
HEALTHCHECK CMD curl --fail http://localhost:4000/healthcheck || exit 1

# START
ENTRYPOINT [ "/bin/sh", "docker-entrypoint.sh" ]
