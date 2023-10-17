#!/usr/bin/env sh

exec /nodejs/bin/node -e 'require("http").get("http://localhost:4000/ar-io/healthcheck", (res) => { if(res.statusCode !== 200) process.exit(1); }).on("error", (err) => { process.exit(1); })'
