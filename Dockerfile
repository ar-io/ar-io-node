ARG NODE_VERSION=20.11.1
ARG NODE_VERSION_SHORT=20

# Build
FROM node:${NODE_VERSION}-bookworm-slim AS builder

WORKDIR /app
RUN apt-get update \
    && apt-get install -y build-essential curl git python3
COPY . .
RUN yarn install \
    && yarn build \
    && rm -rf node_modules \
    && yarn install --production

# Runtime
FROM gcr.io/distroless/nodejs${NODE_VERSION_SHORT}-debian12
WORKDIR /app

# Add sh and mkdir for scripts
COPY --from=busybox:1.35.0-uclibc /bin/sh /bin/sh
COPY --from=busybox:1.35.0-uclibc /bin/mkdir /bin/mkdir

COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist/ ./dist/
COPY ./migrations /app/migrations
COPY ./docker-entrypoint.sh /app/docker-entrypoint.sh
COPY ./healthcheck.sh /app/healthcheck.sh
COPY ./docs/openapi.yaml /app/docs/openapi.yaml

VOLUME /app/data

EXPOSE 4000
HEALTHCHECK CMD /bin/sh healthcheck.sh

LABEL org.opencontainers.image.title="ar.io Core Service"

# Start
ENTRYPOINT [ "/bin/sh", "docker-entrypoint.sh" ]
