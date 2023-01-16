FROM envoyproxy/envoy:v1.22-latest

RUN apt-get update -y && apt-get install -y curl
RUN curl -L https://github.com/vmware-tanzu/carvel-ytt/releases/download/v0.44.1/ytt-linux-amd64 > /usr/local/bin/ytt && chmod 755 /usr/local/bin/ytt

# Copy files
COPY docker-entrypoint.sh /docker-entrypoint.sh
COPY envoy.template.yaml /etc/envoy/envoy.template.yaml

LABEL ECS_PROMETHEUS_EXPORTER_PORT 9901
LABEL ECS_PROMETHEUS_EXPORTER_METRICS_PATH /stats/prometheus

RUN chmod 755 /docker-entrypoint.sh
