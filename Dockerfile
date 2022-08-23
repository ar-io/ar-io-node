FROM node:17 as builder

# BUILD
WORKDIR /app
COPY . .
RUN yarn install
RUN yarn build

# EXTRACT DIST
FROM node:17
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/package.json /app/schema.sql /app/reset-db.sh /app/setup-db.sh ./
COPY --from=builder /app/dist/ ./dist/

# SETUP DB
RUN apt-get update -y && apt-get install sqlite3 -y
RUN mkdir -p data/sqlite
RUN sh setup-db.sh

# START
CMD [ "node", "dist/app.js" ]