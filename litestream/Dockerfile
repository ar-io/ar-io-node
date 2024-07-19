FROM ghcr.io/ar-io/litestream:main@sha256:02c7d75bbd2dc4208789840522e03ae557fd8db88195da2c6298c42fe1bafd15

RUN apk update && apk add --no-cache curl

COPY install-ytt.sh /install-ytt.sh
RUN /install-ytt.sh && rm /install-ytt.sh

# Copy files
COPY docker-entrypoint.sh /docker-entrypoint.sh
COPY litestream.template.yaml /etc/litestream.template.yaml

RUN chmod 755 /docker-entrypoint.sh
ENTRYPOINT /docker-entrypoint.sh
