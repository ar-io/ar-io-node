FROM node:16-alpine as builder

# BUILD
WORKDIR /app
RUN apk --no-cache add git 
COPY . .
RUN yarn install
RUN yarn build

# EXTRACT DIST
FROM node:16-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/package.json /app/schema.sql /app/reset-db.sh /app/setup-db.sh ./
COPY --from=builder /app/dist/ ./dist/

# SETUP DB - TODO: this will be replaced with migration library
RUN apk add --no-cache sqlite curl
RUN mkdir -p data/sqlite
RUN sh setup-db.sh

# START
CMD [ "node", "dist/app.js" ]