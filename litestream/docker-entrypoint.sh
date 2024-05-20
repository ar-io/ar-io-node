#!/usr/bin/env sh

set -e

arch=$(uname -m)

case $arch in
    aarch64) bin_arch="arm64" ;;
    x86_64) bin_arch="amd64" ;;
    *) echo "Unsupported architecture"; exit 1 ;;
esac

wget https://github.com/carvel-dev/ytt/releases/download/v0.49.0/ytt-linux-$bin_arch -O /bin/ytt

chmod +x /bin/ytt

# Update env vars
/bin/ytt -f /etc/litestream.template.yaml --data-values-env TVAL >  /etc/litestream.yml

chmod go+r /etc/litestream.yml

/usr/local/bin/litestream replicate -config /etc/litestream.yml