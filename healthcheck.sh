#!/usr/bin/env sh

exec /nodejs/bin/node -e '
require("http").get("http://localhost:4000/ar-io/healthcheck", (res) => {
  if (res.statusCode !== 200) process.exit(1);
  let data = "";
  res.on("data", (chunk) => { data += chunk; });
  res.on("end", () => {
    try {
      const json = JSON.parse(data);
      if (json.status !== "ok") process.exit(1);
    } catch (e) {
      process.exit(1);
    }
  });
}).on("error", () => { process.exit(1); });
'
