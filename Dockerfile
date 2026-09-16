ARG NODE_VERSION=20.19.6
ARG NODE_VERSION_SHORT=20

# Toolchain plus the manifests, shared by both dependency stages. Nothing here
# depends on source, so editing src/ leaves every layer below this cached.
FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app
RUN apt-get update \
    && apt-get install -y build-essential curl git python3
# .yarnrc carries `ignore-engines true`, which some transitive dependencies need
# to install at all. It was previously swept in by `COPY . .`; copying the
# manifests without it breaks the install. It also raises yarn's network
# timeout: the multi-platform CI build runs both installs below at once for
# each platform, and under arm64 emulation yarn's default 30 s socket timeout
# expires mid-download (ESOCKETTIMEDOUT), failing the image build.
COPY package.json yarn.lock .yarnrc ./

# Full dependency tree, used only to compile.
FROM base AS deps
RUN yarn install

# Runtime dependency tree. Deliberately a sibling of `deps` rather than a step
# after the build: it depends only on the manifests, so editing source does not
# re-resolve it. Previously this ran as `rm -rf node_modules && yarn install
# --production` below the source COPY, so every source change reinstalled the
# whole tree twice.
FROM base AS proddeps
RUN yarn install --production

# Compile. Source changes invalidate this stage and nothing above it.
# node_modules is in .dockerignore, so this cannot clobber the install above.
FROM deps AS builder
COPY . .
RUN yarn build

# Runtime
FROM gcr.io/distroless/nodejs${NODE_VERSION_SHORT}-debian12
WORKDIR /app

# Add sh and mkdir for scripts
COPY --from=busybox:1.35.0-uclibc /bin/sh /bin/sh
COPY --from=busybox:1.35.0-uclibc /bin/mkdir /bin/mkdir

COPY --from=proddeps /app/node_modules ./node_modules/
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist/ ./dist/
COPY ./migrations /app/migrations
COPY ./docker-entrypoint.sh /app/docker-entrypoint.sh
COPY ./healthcheck.sh /app/healthcheck.sh
COPY ./docs/openapi.yaml /app/docs/openapi.yaml
COPY ./resources /app/resources

VOLUME /app/data

EXPOSE 4000
HEALTHCHECK CMD /bin/sh healthcheck.sh

LABEL org.opencontainers.image.title="ar.io Core Service"

# Start
ENTRYPOINT [ "/bin/sh", "docker-entrypoint.sh" ]
