FROM litestream/litestream:0.3.13

# Copy files
COPY docker-entrypoint.sh /docker-entrypoint.sh
COPY litestream.template.yaml /etc/litestream.template.yaml

RUN chmod 755 /docker-entrypoint.sh
ENTRYPOINT /docker-entrypoint.sh
