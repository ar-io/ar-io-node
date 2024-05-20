FROM litestream/litestream:0.3.13

COPY install-ytt.sh /install-ytt.sh
RUN /install-ytt.sh && rm /install-ytt.sh

# Copy files
COPY docker-entrypoint.sh /docker-entrypoint.sh
COPY litestream.template.yaml /etc/litestream.template.yaml

RUN chmod 755 /docker-entrypoint.sh
ENTRYPOINT /docker-entrypoint.sh
