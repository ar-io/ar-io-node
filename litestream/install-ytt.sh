#!/bin/sh

case $(uname -m) in
    "aarch64")
        echo "aarch64"
        curl -L https://github.com/vmware-tanzu/carvel-ytt/releases/download/v0.49.0/ytt-linux-arm64 > /usr/local/bin/ytt
        ;;
    "x86_64")
        echo "x86_64"
        curl -L https://github.com/vmware-tanzu/carvel-ytt/releases/download/v0.49.0/ytt-linux-amd64 > /usr/local/bin/ytt
        ;;
    *)
        echo "Unknown arch"
        exit 1
        ;;
esac

chmod 755 /usr/local/bin/ytt
