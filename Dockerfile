FROM node:17 as builder

# BUILD
WORKDIR /app
COPY . .
RUN yarn install
RUN yarn build

# EXTRACT DIST
FROM node:17
WORKDIR /app
COPY --from=builder /app/package.json /app/yarn.lock /
COPY --from=builder /app/dist dist/
COPY --from=builder /app/schema.sql schema.sql
COPY --from=builder /app/reset-db.sh /

# SETUP DB
RUN apt-get update -y && apt-get install sqlite3 -y
RUN sqlite3 data/sqlite/code.db < schema.sql

# START
CMD [ "node", "dist/app.js" ]