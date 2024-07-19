FROM ghcr.io/ar-io/litestream:main@sha256:fa62d84201b02f48b66a690f2a2082d7cf6c8a2f3ef0b56c9eda59cd3b5aa523

RUN apk update && apk add --no-cache curl

COPY install-ytt.sh /install-ytt.sh
RUN /install-ytt.sh && rm /install-ytt.sh

# Copy files
COPY docker-entrypoint.sh /docker-entrypoint.sh
COPY litestream.template.yaml /etc/litestream.template.yaml

RUN chmod 755 /docker-entrypoint.sh
ENTRYPOINT /docker-entrypoint.sh
